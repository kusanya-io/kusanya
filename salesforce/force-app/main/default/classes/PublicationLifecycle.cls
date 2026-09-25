/**
 * Responsibility: atomically bind reviewed publication artifacts to one immutable version.
 * This internal boundary uses sharing plus user-mode reads/writes, returns only static
 * refusals, and owns the sole trigger authorization for publication transitions.
 * It does not expose an endpoint, select tenant credentials, upload files or publish targets.
 */
public with sharing class PublicationLifecycle {
    private static final String REFUSAL = 'PUBLICATION_COMMIT_REFUSED';
    private static final Pattern SHA256 = Pattern.compile('^[0-9a-f]{64}$');
    private static Map<Id, Form_Version__c> authorizedVersions = new Map<Id, Form_Version__c>();
    private static Map<Id, Form__c> authorizedForms = new Map<Id, Form__c>();

    public class RefusedException extends Exception {
    }

    public class Result {
        public Id formId;
        public Id versionId;
        public String publicationDigest;
        public Boolean alreadyCommitted;

        private Result(
            Id formId,
            Id versionId,
            String publicationDigest,
            Boolean alreadyCommitted
        ) {
            this.formId = formId;
            this.versionId = versionId;
            this.publicationDigest = publicationDigest;
            this.alreadyCommitted = alreadyCommitted;
        }
    }

    public static Result commitPublication(
        Id versionId,
        String publicationDigest,
        Id xformVersionId,
        Id xlsformVersionId,
        String compileWarnings
    ) {
        if (compileWarnings == '') {
            compileWarnings = null;
        }
        validateRequest(
            versionId,
            publicationDigest,
            xformVersionId,
            xlsformVersionId,
            compileWarnings
        );
        try {
            Form_Version__c identity = [
                SELECT Id, Form__c
                FROM Form_Version__c
                WHERE Id = :versionId
                WITH USER_MODE
            ];
            Form__c form = [
                SELECT Id, Status__c, Current_Version__c
                FROM Form__c
                WHERE Id = :identity.Form__c
                WITH USER_MODE
                FOR UPDATE
            ];
            List<Form_Version__c> versions = [
                SELECT
                    Id,
                    Form__c,
                    Version_Number__c,
                    Status__c,
                    XForm__c,
                    XLSForm__c,
                    XForm_Version__c,
                    XLSForm_Version__c,
                    Compiled_At__c,
                    Compile_Warnings__c,
                    Published_By__c,
                    Published_At__c,
                    Publication_Digest__c,
                    Change_Log__c,
                    Version_Key__c
                FROM Form_Version__c
                WHERE Form__c = :identity.Form__c
                WITH USER_MODE
                FOR UPDATE
            ];
            Form_Version__c target = new Map<Id, Form_Version__c>(versions)
                .get(versionId);
            if (target == null) {
                refuse();
            }
            Map<Id, ContentVersion> artifacts = new Map<Id, ContentVersion>(
                [
                    SELECT
                        Id,
                        ContentDocumentId,
                        CreatedById,
                        FileExtension,
                        IsLatest
                    FROM ContentVersion
                    WHERE Id IN :new Set<Id>{ xformVersionId, xlsformVersionId }
                    WITH USER_MODE
                ]
            );
            List<ContentDocumentLink> links = [
                SELECT ContentDocumentId, LinkedEntityId
                FROM ContentDocumentLink
                WHERE LinkedEntityId = :target.Id
                WITH USER_MODE
            ];
            validateArtifacts(
                artifacts,
                xformVersionId,
                xlsformVersionId,
                target.Status__c == 'Draft'
            );
            Id xformDocumentId = artifacts.get(xformVersionId)
                .ContentDocumentId;
            Id xlsformDocumentId = artifacts
                .get(xlsformVersionId)
                .ContentDocumentId;

            List<Form_Version__c> published = new List<Form_Version__c>();
            for (Form_Version__c version : versions) {
                if (version.Status__c == 'Published') {
                    published.add(version);
                }
            }
            if (target.Status__c == 'Published') {
                if (
                    published.size() != 1 ||
                    published[0].Id != target.Id ||
                    form.Status__c != 'Published' ||
                    form.Current_Version__c != target.Id ||
                    !matchesCommit(
                        target,
                        publicationDigest,
                        xformVersionId,
                        xlsformVersionId,
                        xformDocumentId,
                        xlsformDocumentId,
                        compileWarnings
                    ) ||
                    !hasExactLinks(links, xformDocumentId, xlsformDocumentId)
                ) {
                    refuse();
                }
                return new Result(form.Id, target.Id, publicationDigest, true);
            }
            if (
                target.Status__c != 'Draft' ||
                hasPublicationMetadata(target) ||
                !links.isEmpty() ||
                published.size() > 1 ||
                (published.isEmpty() &&
                (form.Status__c != 'Draft' ||
                (form.Current_Version__c != null &&
                form.Current_Version__c != target.Id))) ||
                (!published.isEmpty() &&
                (form.Status__c != 'Published' ||
                form.Current_Version__c != published[0].Id))
            ) {
                refuse();
            }

            Savepoint checkpoint = Database.setSavepoint();
            try {
                Database.insert(
                    new List<ContentDocumentLink>{
                        new ContentDocumentLink(
                            ContentDocumentId = xformDocumentId,
                            LinkedEntityId = target.Id,
                            ShareType = 'V',
                            Visibility = 'AllUsers'
                        ),
                        new ContentDocumentLink(
                            ContentDocumentId = xlsformDocumentId,
                            LinkedEntityId = target.Id,
                            ShareType = 'V',
                            Visibility = 'AllUsers'
                        )
                    },
                    true,
                    AccessLevel.USER_MODE
                );

                Datetime committedAt = Datetime.newInstance(
                    System.now().getTime() / 1000 * 1000
                );
                List<Form_Version__c> expectedVersions = new List<Form_Version__c>();
                List<Form_Version__c> versionUpdates = new List<Form_Version__c>();
                if (!published.isEmpty()) {
                    Form_Version__c previous = published[0]
                        .clone(true, true, false, false);
                    previous.Status__c = 'Superseded';
                    expectedVersions.add(previous);
                    versionUpdates.add(
                        new Form_Version__c(
                            Id = previous.Id,
                            Status__c = 'Superseded'
                        )
                    );
                }
                Form_Version__c committed = target.clone(
                    true,
                    true,
                    false,
                    false
                );
                committed.Status__c = 'Published';
                committed.XForm__c = String.valueOf(xformDocumentId);
                committed.XLSForm__c = String.valueOf(xlsformDocumentId);
                committed.XForm_Version__c = String.valueOf(xformVersionId);
                committed.XLSForm_Version__c = String.valueOf(xlsformVersionId);
                committed.Compiled_At__c = committedAt;
                committed.Compile_Warnings__c = compileWarnings;
                committed.Published_By__c = UserInfo.getUserId();
                committed.Published_At__c = committedAt;
                committed.Publication_Digest__c = publicationDigest;
                expectedVersions.add(committed);
                versionUpdates.add(
                    new Form_Version__c(
                        Id = committed.Id,
                        Status__c = 'Published',
                        XForm__c = committed.XForm__c,
                        XLSForm__c = committed.XLSForm__c,
                        XForm_Version__c = committed.XForm_Version__c,
                        XLSForm_Version__c = committed.XLSForm_Version__c,
                        Compiled_At__c = committedAt,
                        Compile_Warnings__c = compileWarnings,
                        Published_By__c = UserInfo.getUserId(),
                        Published_At__c = committedAt,
                        Publication_Digest__c = publicationDigest
                    )
                );

                authorizeVersions(expectedVersions);
                Database.update(versionUpdates, true, AccessLevel.USER_MODE);

                Form__c publishedForm = form.clone(true, true, false, false);
                publishedForm.Status__c = 'Published';
                publishedForm.Current_Version__c = target.Id;
                authorizedForms.put(publishedForm.Id, publishedForm);
                Database.update(publishedForm, true, AccessLevel.USER_MODE);
                return new Result(form.Id, target.Id, publicationDigest, false);
            } catch (Exception error) {
                Database.rollback(checkpoint);
                refuse();
                return null;
            } finally {
                authorizedVersions.clear();
                authorizedForms.clear();
            }
        } catch (RefusedException error) {
            throw error;
        } catch (Exception error) {
            refuse();
            return null;
        }
    }

    public static void validateVersions(
        List<Form_Version__c> incoming,
        Map<Id, Form_Version__c> original,
        Boolean deleting
    ) {
        for (Form_Version__c version : incoming) {
            Form_Version__c before = original == null
                ? null
                : original.get(version.Id);
            if (deleting) {
                if (version.Status__c != 'Draft') {
                    version.addError('Published definitions are immutable.');
                }
            } else if (before == null) {
                if (
                    version.Status__c != 'Draft' ||
                    hasPublicationMetadata(version)
                ) {
                    version.addError('Publication fields are lifecycle-owned.');
                }
            } else if (authorizedVersions.containsKey(version.Id)) {
                if (!sameVersion(version, authorizedVersions.get(version.Id))) {
                    version.addError('Publication transition was altered.');
                }
            } else if (
                before.Status__c != 'Draft' ||
                version.Status__c != 'Draft' ||
                publicationMetadataChanged(before, version)
            ) {
                version.addError('Published definitions are immutable.');
            }
        }
    }

    public static void validateForms(
        List<Form__c> incoming,
        Map<Id, Form__c> original
    ) {
        for (Form__c form : incoming) {
            Form__c before = original == null ? null : original.get(form.Id);
            if (before == null) {
                if (form.Status__c != 'Draft') {
                    form.addError('Publication fields are lifecycle-owned.');
                }
                continue;
            }
            if (authorizedForms.containsKey(form.Id)) {
                Form__c expected = authorizedForms.get(form.Id);
                if (
                    form.Status__c != expected.Status__c ||
                    form.Current_Version__c != expected.Current_Version__c ||
                    !sameFormDefinition(before, form)
                ) {
                    form.addError('Publication transition was altered.');
                }
            } else if (
                form.Status__c != before.Status__c ||
                (before.Status__c != 'Draft' &&
                form.Current_Version__c != before.Current_Version__c)
            ) {
                form.addError('Publication fields are lifecycle-owned.');
            }
        }
    }

    public static void validateFormDeletion(List<Form__c> deleting) {
        Set<Id> formIds = new Map<Id, Form__c>(deleting).keySet();
        Set<Id> protectedForms = new Set<Id>();
        for (Form_Version__c version : [
            SELECT Form__c
            FROM Form_Version__c
            WHERE Form__c IN :formIds AND Status__c != 'Draft'
        ]) {
            protectedForms.add(version.Form__c);
        }
        for (Form__c form : deleting) {
            if (protectedForms.contains(form.Id)) {
                form.addError('Published definitions are immutable.');
            }
        }
    }

    private static void authorizeVersions(List<Form_Version__c> versions) {
        for (Form_Version__c version : versions) {
            authorizedVersions.put(version.Id, version);
        }
    }

    private static void validateRequest(
        Id versionId,
        String publicationDigest,
        Id xformVersionId,
        Id xlsformVersionId,
        String compileWarnings
    ) {
        if (
            versionId == null ||
            versionId.getSObjectType() != Form_Version__c.SObjectType ||
            publicationDigest == null ||
            !SHA256.matcher(publicationDigest).matches() ||
            xformVersionId == null ||
            xlsformVersionId == null ||
            xformVersionId == xlsformVersionId ||
            xformVersionId.getSObjectType() != ContentVersion.SObjectType ||
            xlsformVersionId.getSObjectType() != ContentVersion.SObjectType ||
            (compileWarnings != null &&
            compileWarnings.length() > 32768)
        ) {
            refuse();
        }
    }

    private static void validateArtifacts(
        Map<Id, ContentVersion> artifacts,
        Id xformVersionId,
        Id xlsformVersionId,
        Boolean requireLatest
    ) {
        ContentVersion xform = artifacts.get(xformVersionId);
        ContentVersion xlsform = artifacts.get(xlsformVersionId);
        if (
            xform == null ||
            xlsform == null ||
            xform.ContentDocumentId == xlsform.ContentDocumentId ||
            xform.CreatedById != UserInfo.getUserId() ||
            xlsform.CreatedById != UserInfo.getUserId() ||
            xform.FileExtension == null ||
            xform.FileExtension.toLowerCase() != 'xml' ||
            xlsform.FileExtension == null ||
            xlsform.FileExtension.toLowerCase() != 'xlsx' ||
            (requireLatest && (!xform.IsLatest || !xlsform.IsLatest))
        ) {
            refuse();
        }
    }

    private static Boolean matchesCommit(
        Form_Version__c version,
        String publicationDigest,
        Id xformVersionId,
        Id xlsformVersionId,
        Id xformDocumentId,
        Id xlsformDocumentId,
        String compileWarnings
    ) {
        return version.Publication_Digest__c == publicationDigest &&
            version.XForm__c == String.valueOf(xformDocumentId) &&
            version.XLSForm__c == String.valueOf(xlsformDocumentId) &&
            version.XForm_Version__c == String.valueOf(xformVersionId) &&
            version.XLSForm_Version__c == String.valueOf(xlsformVersionId) &&
            version.Compile_Warnings__c == compileWarnings &&
            version.Compiled_At__c != null &&
            version.Published_At__c != null &&
            version.Compiled_At__c == version.Published_At__c &&
            version.Published_By__c == UserInfo.getUserId();
    }

    private static Boolean hasExactLinks(
        List<ContentDocumentLink> links,
        Id xformDocumentId,
        Id xlsformDocumentId
    ) {
        Set<Id> documentIds = new Set<Id>();
        for (ContentDocumentLink link : links) {
            documentIds.add(link.ContentDocumentId);
        }
        return links.size() == 2 &&
            documentIds == new Set<Id>{ xformDocumentId, xlsformDocumentId };
    }

    private static Boolean hasPublicationMetadata(Form_Version__c version) {
        return version.XForm__c != null ||
            version.XLSForm__c != null ||
            version.XForm_Version__c != null ||
            version.XLSForm_Version__c != null ||
            version.Compiled_At__c != null ||
            version.Compile_Warnings__c != null ||
            version.Published_By__c != null ||
            version.Published_At__c != null ||
            version.Publication_Digest__c != null;
    }

    private static Boolean publicationMetadataChanged(
        Form_Version__c before,
        Form_Version__c after
    ) {
        return before.XForm__c != after.XForm__c ||
            before.XLSForm__c != after.XLSForm__c ||
            before.XForm_Version__c != after.XForm_Version__c ||
            before.XLSForm_Version__c != after.XLSForm_Version__c ||
            before.Compiled_At__c != after.Compiled_At__c ||
            before.Compile_Warnings__c != after.Compile_Warnings__c ||
            before.Published_By__c != after.Published_By__c ||
            before.Published_At__c != after.Published_At__c ||
            before.Publication_Digest__c != after.Publication_Digest__c;
    }

    private static Boolean sameVersion(
        Form_Version__c actual,
        Form_Version__c expected
    ) {
        return actual.Form__c == expected.Form__c &&
            actual.Version_Number__c == expected.Version_Number__c &&
            actual.Status__c == expected.Status__c &&
            actual.XForm__c == expected.XForm__c &&
            actual.XLSForm__c == expected.XLSForm__c &&
            actual.XForm_Version__c == expected.XForm_Version__c &&
            actual.XLSForm_Version__c == expected.XLSForm_Version__c &&
            actual.Compiled_At__c == expected.Compiled_At__c &&
            actual.Compile_Warnings__c == expected.Compile_Warnings__c &&
            actual.Published_By__c == expected.Published_By__c &&
            actual.Published_At__c == expected.Published_At__c &&
            actual.Publication_Digest__c == expected.Publication_Digest__c &&
            actual.Change_Log__c == expected.Change_Log__c &&
            actual.Version_Key__c == expected.Version_Key__c;
    }

    private static Boolean sameFormDefinition(Form__c before, Form__c after) {
        return before.Name == after.Name &&
            before.Description__c == after.Description__c &&
            before.Folder__c == after.Folder__c &&
            before.Default_Target_Object__c == after.Default_Target_Object__c &&
            before.Language__c == after.Language__c &&
            before.Country__c == after.Country__c &&
            before.Allow_Ad_Hoc_Submissions__c ==
            after.Allow_Ad_Hoc_Submissions__c &&
            before.GPS_Capture__c == after.GPS_Capture__c &&
            before.Close_Message__c == after.Close_Message__c;
    }

    private static void refuse() {
        throw new RefusedException(REFUSAL);
    }
}
