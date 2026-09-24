/**
 * Responsibility: refuse every direct mutation whose definition graph reaches a
 * Published or Superseded Form Version. System-mode relationship reads are
 * deliberate so hidden records cannot bypass integrity. This class performs no DML.
 */
public without sharing class PublishedDefinitionGuard {
    private static final String IMMUTABLE = 'Published definitions are immutable.';

    private class ChoiceProtection {
        Set<Id> listIds = new Set<Id>();
        Set<Id> ownerQuestionIds = new Set<Id>();
    }

    public static void protectQuestions(List<Question__c> records) {
        Set<Id> versionIds = new Set<Id>();
        for (Question__c record : records) {
            versionIds.add(record.Form_Version__c);
        }
        addQuestionErrors(records, protectedVersions(versionIds));
    }

    public static void protectMappings(List<Mapping__c> records) {
        Set<Id> versionIds = new Set<Id>();
        for (Mapping__c record : records) {
            versionIds.add(record.Form_Version__c);
        }
        Set<Id> protectedIds = protectedVersions(versionIds);
        for (Mapping__c record : records) {
            if (protectedIds.contains(record.Form_Version__c)) {
                record.addError(IMMUTABLE);
            }
        }
    }

    public static void protectFieldMappings(List<Field_Mapping__c> records) {
        Set<Id> mappingIds = new Set<Id>();
        for (Field_Mapping__c record : records) {
            mappingIds.add(record.Mapping__c);
        }
        mappingIds.remove(null);
        Set<Id> protectedMappings = new Set<Id>();
        for (Mapping__c mapping : [
            SELECT Id
            FROM Mapping__c
            WHERE Id IN :mappingIds AND Form_Version__r.Status__c != 'Draft'
        ]) {
            protectedMappings.add(mapping.Id);
        }
        for (Field_Mapping__c record : records) {
            if (protectedMappings.contains(record.Mapping__c)) {
                record.addError(IMMUTABLE);
            }
        }
    }

    public static void protectSkipRules(List<Skip_Rule__c> records) {
        Set<Id> questionIds = new Set<Id>();
        for (Skip_Rule__c record : records) {
            questionIds.add(record.Question__c);
        }
        questionIds.remove(null);
        Set<Id> protectedQuestions = new Set<Id>();
        for (Question__c question : [
            SELECT Id
            FROM Question__c
            WHERE Id IN :questionIds AND Form_Version__r.Status__c != 'Draft'
        ]) {
            protectedQuestions.add(question.Id);
        }
        for (Skip_Rule__c record : records) {
            if (protectedQuestions.contains(record.Question__c)) {
                record.addError(IMMUTABLE);
            }
        }
    }

    public static void protectChoiceLists(List<Choice_List__c> records) {
        Set<Id> listIds = new Set<Id>();
        Set<Id> ownerQuestionIds = new Set<Id>();
        for (Choice_List__c record : records) {
            listIds.add(record.Id);
            ownerQuestionIds.add(record.Owner_Question__c);
        }
        listIds.remove(null);
        ownerQuestionIds.remove(null);
        ChoiceProtection protection = protectedChoiceLists(
            listIds,
            ownerQuestionIds
        );
        for (Choice_List__c record : records) {
            if (
                protection.listIds.contains(record.Id) ||
                protection.ownerQuestionIds.contains(record.Owner_Question__c)
            ) {
                record.addError(IMMUTABLE);
            }
        }
    }

    public static void protectChoices(List<Choice__c> records) {
        Set<Id> listIds = new Set<Id>();
        for (Choice__c record : records) {
            listIds.add(record.Choice_List__c);
        }
        listIds.remove(null);
        Set<Id> ownerQuestionIds = new Set<Id>();
        for (Choice_List__c listDefinition : [
            SELECT Owner_Question__c
            FROM Choice_List__c
            WHERE Id IN :listIds
        ]) {
            ownerQuestionIds.add(listDefinition.Owner_Question__c);
        }
        ownerQuestionIds.remove(null);
        ChoiceProtection protection = protectedChoiceLists(
            listIds,
            ownerQuestionIds
        );
        for (Choice__c record : records) {
            if (protection.listIds.contains(record.Choice_List__c)) {
                record.addError(IMMUTABLE);
            }
        }
    }

    private static ChoiceProtection protectedChoiceLists(
        Set<Id> listIds,
        Set<Id> ownerQuestionIds
    ) {
        ChoiceProtection protection = new ChoiceProtection();
        for (Question__c question : [
            SELECT Id, Choice_List__c
            FROM Question__c
            WHERE
                (Choice_List__c IN :listIds
                OR Id IN :ownerQuestionIds)
                AND Form_Version__r.Status__c != 'Draft'
        ]) {
            if (question.Choice_List__c != null) {
                protection.listIds.add(question.Choice_List__c);
            }
            if (ownerQuestionIds.contains(question.Id)) {
                protection.ownerQuestionIds.add(question.Id);
            }
        }
        for (Choice_List__c listDefinition : [
            SELECT Id, Owner_Question__c
            FROM Choice_List__c
            WHERE Id IN :listIds
        ]) {
            if (
                protection.ownerQuestionIds.contains(
                    listDefinition.Owner_Question__c
                )
            ) {
                protection.listIds.add(listDefinition.Id);
            }
        }
        return protection;
    }

    private static Set<Id> protectedVersions(Set<Id> versionIds) {
        versionIds.remove(null);
        Set<Id> protectedIds = new Set<Id>();
        for (Form_Version__c version : [
            SELECT Id
            FROM Form_Version__c
            WHERE Id IN :versionIds AND Status__c != 'Draft'
        ]) {
            protectedIds.add(version.Id);
        }
        return protectedIds;
    }

    private static void addQuestionErrors(
        List<Question__c> records,
        Set<Id> protectedIds
    ) {
        for (Question__c record : records) {
            if (protectedIds.contains(record.Form_Version__c)) {
                record.addError(IMMUTABLE);
            }
        }
    }
}
