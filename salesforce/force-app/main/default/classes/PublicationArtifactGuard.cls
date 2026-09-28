/**
 * Responsibility: prevent deletion or unlinking of Salesforce File documents
 * pinned by a committed publication. System-mode reads are deliberate: hidden
 * publication records must not permit artifact loss. This class performs no DML
 * and discloses no record or file identity. Salesforce itself refuses direct
 * ContentVersion deletion before Apex runs.
 */
public without sharing class PublicationArtifactGuard {
    private static final String IMMUTABLE = 'Published artifacts are immutable.';

    public static void protectDocuments(List<ContentDocument> deleting) {
        Set<String> ids = new Set<String>();
        for (ContentDocument document : deleting) {
            ids.add(String.valueOf(document.Id));
        }
        Set<String> protectedIds = new Set<String>();
        for (Form_Version__c publication : [
            SELECT XForm__c, XLSForm__c
            FROM Form_Version__c
            WHERE XForm__c IN :ids OR XLSForm__c IN :ids
        ]) {
            protectedIds.add(publication.XForm__c);
            protectedIds.add(publication.XLSForm__c);
        }
        protectedIds.remove(null);
        for (ContentDocument document : deleting) {
            if (protectedIds.contains(String.valueOf(document.Id))) {
                document.addError(IMMUTABLE);
            }
        }
    }

    public static void protectLinks(List<ContentDocumentLink> deleting) {
        Set<Id> publicationIds = new Set<Id>();
        for (ContentDocumentLink link : deleting) {
            if (
                link.LinkedEntityId != null &&
                link.LinkedEntityId.getSObjectType() ==
                Form_Version__c.SObjectType
            ) {
                publicationIds.add(link.LinkedEntityId);
            }
        }
        Map<Id, Form_Version__c> publications = new Map<Id, Form_Version__c>(
            [
                SELECT XForm__c, XLSForm__c
                FROM Form_Version__c
                WHERE Id IN :publicationIds
            ]
        );
        for (ContentDocumentLink link : deleting) {
            Form_Version__c publication = publications.get(link.LinkedEntityId);
            if (
                publication != null &&
                (publication.XForm__c ==
                String.valueOf(link.ContentDocumentId) ||
                publication.XLSForm__c ==
                String.valueOf(link.ContentDocumentId))
            ) {
                link.addError(IMMUTABLE);
            }
        }
    }
}
