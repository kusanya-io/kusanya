/**
 * Responsibility: remove target-owned skip rules before direct Form/Version deletion.
 * Preserves native source-question restrictions outside the owner cascade.
 * Without sharing matches the owning cascade; this is not a reader or public API.
 * One bulk query and at most one all-or-none DML per owner trigger invocation.
 * No cached IDs or partial child deletion: failed owner deletes must roll back cleanup.
 * Publication/submission protection and inline choice lifecycle remain separate work.
 */
public without sharing class DefinitionDeletionHandler {
    public static void beforeFormsDelete(Set<Id> formIds) {
        List<Skip_Rule__c> rules = [
            SELECT Id
            FROM Skip_Rule__c
            WHERE Question__r.Form_Version__r.Form__c IN :formIds
        ];
        if (!rules.isEmpty()) {
            delete rules;
        }
    }

    public static void beforeVersionsDelete(Set<Id> versionIds) {
        List<Skip_Rule__c> rules = [
            SELECT Id
            FROM Skip_Rule__c
            WHERE Question__r.Form_Version__c IN :versionIds
        ];
        if (!rules.isEmpty()) {
            delete rules;
        }
    }
}
