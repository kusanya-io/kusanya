/**
 * Responsibility: prove explicit per-Form publisher sharing grants and revokes
 * cross-owner publication access without widening object permissions or ownership.
 * Uses only synthetic users, definitions and files; no external endpoint or C10 claim.
 */
@IsTest
private class PublisherRecordAccessTest {
    private static final String DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    @IsTest
    static void explicitShareEnablesCrossOwnerPublication() {
        User publisher;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            publisher = createUser('publish');
            assignPermission(publisher.Id, 'Kusanya_Integration');
        }

        Form__c form = new Form__c(Name = 'Administrator definition');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;

        Map<String, Id> files;
        System.runAs(publisher) {
            files = createFiles('cross-owner');
            assertCommitRefused(version.Id, files);
        }
        Assert.areEqual(
            'Draft',
            [SELECT Status__c FROM Form_Version__c WHERE Id = :version.Id]
            .Status__c
        );

        form.Publisher__c = publisher.Id;
        update form;
        assertShare(form.Id, publisher.Id);

        System.runAs(publisher) {
            PublicationLifecycle.Result result = PublicationLifecycle.commitPublication(
                version.Id,
                DIGEST,
                files.get('xml'),
                files.get('xlsx'),
                null
            );
            Assert.isFalse(result.alreadyCommitted);
            Assert.areEqual(version.Id, result.versionId);
        }
        Form_Version__c published = [
            SELECT Status__c, Published_By__c, Publication_Digest__c
            FROM Form_Version__c
            WHERE Id = :version.Id
        ];
        Assert.areEqual('Published', published.Status__c);
        Assert.areEqual(publisher.Id, published.Published_By__c);
        Assert.areEqual(DIGEST, published.Publication_Digest__c);
    }

    @IsTest
    static void replacementRevocationAndOwnerChangesStayScoped() {
        User first;
        User second;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            first = createUser('first');
            second = createUser('second');
            assignPermission(first.Id, 'Kusanya_Integration');
            assignPermission(second.Id, 'Kusanya_Integration');
        }

        Form__c form = new Form__c(
            Name = 'Scoped publisher',
            Publisher__c = first.Id
        );
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        assertShare(form.Id, first.Id);
        assertCanUpdate(first, version.Id, 'first publisher');
        assertCannotUpdate(second, version.Id, 'unselected publisher');

        form.Publisher__c = second.Id;
        update form;
        assertShare(form.Id, second.Id);
        assertCannotUpdate(first, version.Id, 'replaced publisher');
        assertCanUpdate(second, version.Id, 'second publisher');

        form.Publisher__c = null;
        update form;
        assertNoPublisherShare(form.Id);
        assertCannotUpdate(second, version.Id, 'revoked publisher');

        form.Publisher__c = first.Id;
        update form;
        assertShare(form.Id, first.Id);
        form.OwnerId = first.Id;
        update form;
        assertNoPublisherShare(form.Id);
        assertCanUpdate(first, version.Id, 'publisher owner');

        form.OwnerId = UserInfo.getUserId();
        update form;
        assertShare(form.Id, first.Id);
        assertCanUpdate(first, version.Id, 'publisher after owner transfer');
    }

    @IsTest
    static void publisherCannotConvertShareIntoOwnership() {
        User publisher;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            publisher = createUser('owner');
            assignPermission(publisher.Id, 'Kusanya_Integration');
        }
        Form__c form = new Form__c(
            Name = 'Ownership boundary',
            Publisher__c = publisher.Id
        );
        insert form;
        assertShare(form.Id, publisher.Id);

        System.runAs(publisher) {
            Database.SaveResult result = Database.update(
                new Form__c(Id = form.Id, OwnerId = publisher.Id),
                false
            );
            Assert.isFalse(result.isSuccess());
            Assert.isTrue(
                result.getErrors()[0]
                    .getMessage()
                    .contains('selected publisher cannot transfer ownership')
            );
        }

        Form__c unchanged = [
            SELECT OwnerId, Publisher__c
            FROM Form__c
            WHERE Id = :form.Id
        ];
        Assert.areEqual(UserInfo.getUserId(), unchanged.OwnerId);
        Assert.areEqual(publisher.Id, unchanged.Publisher__c);
        assertShare(form.Id, publisher.Id);
    }

    @IsTest
    static void bulkReconciliationUsesOneShareBatchAndIgnoresOtherEdits() {
        User publisher;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            publisher = createUser('bulk');
        }
        List<Form__c> forms = new List<Form__c>();
        for (Integer index = 0; index < 200; index++) {
            forms.add(
                new Form__c(
                    Name = 'Bulk publisher ' + index,
                    Publisher__c = publisher.Id
                )
            );
        }

        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        insert forms;
        Assert.areEqual(queriesBefore + 1, Limits.getQueries());
        Assert.areEqual(dmlBefore + 2, Limits.getDmlStatements());

        Set<Id> formIds = new Map<Id, Form__c>(forms).keySet();
        String publisherCause = publisherCause();
        Assert.areEqual(
            200,
            [
                SELECT COUNT()
                FROM Form__Share
                WHERE
                    ParentId IN :formIds
                    AND UserOrGroupId = :publisher.Id
                    AND AccessLevel = 'Edit'
                    AND RowCause = :publisherCause
            ]
        );

        for (Form__c form : forms) {
            form.Description__c = 'Unrelated author edit';
        }
        queriesBefore = Limits.getQueries();
        dmlBefore = Limits.getDmlStatements();
        update forms;
        Assert.areEqual(queriesBefore, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
    }

    private static void assertShare(Id formId, Id publisherId) {
        String cause = publisherCause();
        List<Form__Share> shares = [
            SELECT AccessLevel, UserOrGroupId
            FROM Form__Share
            WHERE ParentId = :formId AND RowCause = :cause
        ];
        Assert.areEqual(1, shares.size());
        Assert.areEqual(publisherId, shares[0].UserOrGroupId);
        Assert.areEqual('Edit', shares[0].AccessLevel);
    }

    private static void assertNoPublisherShare(Id formId) {
        String cause = publisherCause();
        Assert.areEqual(
            0,
            [
                SELECT COUNT()
                FROM Form__Share
                WHERE ParentId = :formId AND RowCause = :cause
            ]
        );
    }

    private static String publisherCause() {
        return String.valueOf(Schema.Form__Share.RowCause.Publisher_Access__c);
    }

    private static void assertCanUpdate(
        User principal,
        Id versionId,
        String marker
    ) {
        System.runAs(principal) {
            Database.SaveResult result = Database.update(
                new Form_Version__c(Id = versionId, Change_Log__c = marker),
                false,
                AccessLevel.USER_MODE
            );
            Assert.isTrue(result.isSuccess());
        }
    }

    private static void assertCannotUpdate(
        User principal,
        Id versionId,
        String marker
    ) {
        System.runAs(principal) {
            Database.SaveResult result = Database.update(
                new Form_Version__c(Id = versionId, Change_Log__c = marker),
                false,
                AccessLevel.USER_MODE
            );
            Assert.isFalse(result.isSuccess());
        }
    }

    private static void assertCommitRefused(
        Id versionId,
        Map<String, Id> files
    ) {
        try {
            PublicationLifecycle.commitPublication(
                versionId,
                DIGEST,
                files.get('xml'),
                files.get('xlsx'),
                null
            );
            Assert.fail('Expected cross-owner publication to refuse');
        } catch (PublicationLifecycle.RefusedException error) {
            Assert.areEqual('PUBLICATION_COMMIT_REFUSED', error.getMessage());
        }
    }

    private static Map<String, Id> createFiles(String marker) {
        Id xml = createFile(marker + '.xml', '<data/>');
        Id xlsx = createFile(marker + '.xlsx', 'synthetic workbook');
        return new Map<String, Id>{ 'xml' => xml, 'xlsx' => xlsx };
    }

    private static Id createFile(String path, String body) {
        ContentVersion version = new ContentVersion(
            Title = path.substring(0, path.lastIndexOf('.')),
            PathOnClient = path,
            VersionData = Blob.valueOf(body)
        );
        insert version;
        return version.Id;
    }

    private static User createUser(String marker) {
        Profile profile = [
            SELECT Id
            FROM Profile
            WHERE Name = 'Standard User'
            LIMIT 1
        ];
        String unique = marker + '.' + String.valueOf(DateTime.now().getTime());
        User user = new User(
            Alias = marker.left(8),
            Email = unique + '@example.invalid',
            EmailEncodingKey = 'UTF-8',
            LastName = 'Publisher ' + marker,
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = profile.Id,
            TimeZoneSidKey = 'Africa/Nairobi',
            Username = unique + '@example.invalid'
        );
        insert user;
        return user;
    }

    private static void assignPermission(Id userId, String developerName) {
        PermissionSet permission = [
            SELECT Id
            FROM PermissionSet
            WHERE Name = :developerName
            LIMIT 1
        ];
        insert new PermissionSetAssignment(
            AssigneeId = userId,
            PermissionSetId = permission.Id
        );
    }
}
