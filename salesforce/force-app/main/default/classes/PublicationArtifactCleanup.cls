/**
 * Responsibility: atomically delete the exact private Files left by a publication
 * attempt that the service has already reconciled as unlinked. The caller must
 * supply the immutable Form Version, digest and ContentVersion identities. This
 * boundary locks the Form before rechecking draft state, refuses any linked or
 * foreign artifact, performs user-mode deletion and discloses no record identity.
 */
public with sharing class PublicationArtifactCleanup {
    private static final Pattern SHA256 = Pattern.compile('^[0-9a-f]{64}$');

    public class RefusedException extends Exception {
    }

    public static void deleteUnlinkedArtifacts(
        Id versionId,
        String publicationDigest,
        Id xformVersionId,
        Id xlsformVersionId
    ) {
        validateRequest(
            versionId,
            publicationDigest,
            xformVersionId,
            xlsformVersionId
        );
        try {
            Form_Version__c identity = [
                SELECT Id, Form__c
                FROM Form_Version__c
                WHERE Id = :versionId
                WITH USER_MODE
            ];
            Form__c lockedForm = [
                SELECT Id
                FROM Form__c
                WHERE Id = :identity.Form__c
                WITH USER_MODE
                FOR UPDATE
            ];
            Form_Version__c target = [
                SELECT
                    Id,
                    Status__c,
                    XForm__c,
                    XLSForm__c,
                    XForm_Version__c,
                    XLSForm_Version__c,
                    Compiled_At__c,
                    Compile_Warnings__c,
                    Published_By__c,
                    Published_At__c,
                    Publication_Digest__c
                FROM Form_Version__c
                WHERE Id = :versionId
                WITH USER_MODE
                FOR UPDATE
            ];
            if (
                target.Status__c != 'Draft' ||
                target.XForm__c != null ||
                target.XLSForm__c != null ||
                target.XForm_Version__c != null ||
                target.XLSForm_Version__c != null ||
                target.Compiled_At__c != null ||
                target.Compile_Warnings__c != null ||
                target.Published_By__c != null ||
                target.Published_At__c != null ||
                target.Publication_Digest__c != null
            ) {
                refuse();
            }

            Map<Id, ContentVersion> versions = new Map<Id, ContentVersion>(
                [
                    SELECT
                        Id,
                        ContentDocumentId,
                        CreatedById,
                        FileExtension,
                        IsLatest,
                        Title
                    FROM ContentVersion
                    WHERE Id IN :new Set<Id>{ xformVersionId, xlsformVersionId }
                    WITH USER_MODE
                ]
            );
            if (versions.size() != 2) {
                refuse();
            }
            ContentVersion xform = versions.get(xformVersionId);
            ContentVersion xlsform = versions.get(xlsformVersionId);
            if (
                xform == null ||
                xlsform == null ||
                xform.ContentDocumentId == xlsform.ContentDocumentId ||
                xform.CreatedById != UserInfo.getUserId() ||
                xlsform.CreatedById != UserInfo.getUserId() ||
                xform.IsLatest != true ||
                xlsform.IsLatest != true ||
                xform.FileExtension != 'xml' ||
                xlsform.FileExtension != 'xlsx' ||
                xform.Title != 'kusanya-' + publicationDigest + '-xform' ||
                xlsform.Title != 'kusanya-' + publicationDigest + '-xlsform'
            ) {
                refuse();
            }
            Set<Id> documentIds = new Set<Id>{
                xform.ContentDocumentId,
                xlsform.ContentDocumentId
            };
            if (
                PublicationArtifactGuard.hasDisallowedLinks(
                    documentIds,
                    UserInfo.getUserId()
                )
            ) {
                refuse();
            }

            Savepoint checkpoint = Database.setSavepoint();
            try {
                Database.delete(
                    new List<ContentDocument>{
                        new ContentDocument(Id = xform.ContentDocumentId),
                        new ContentDocument(Id = xlsform.ContentDocumentId)
                    },
                    true,
                    AccessLevel.USER_MODE
                );
            } catch (Exception error) {
                Database.rollback(checkpoint);
                refuse();
            }
        } catch (RefusedException error) {
            throw error;
        } catch (Exception error) {
            refuse();
        }
    }

    private static void validateRequest(
        Id versionId,
        String publicationDigest,
        Id xformVersionId,
        Id xlsformVersionId
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
            xlsformVersionId.getSObjectType() != ContentVersion.SObjectType
        ) {
            refuse();
        }
    }

    private static void refuse() {
        throw new RefusedException('PUBLICATION_ARTIFACT_CLEANUP_REFUSED');
    }
}
