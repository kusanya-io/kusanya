/**
 * Responsibility: protect inline-list ownership and derive per-list choice identity.
 * Integrity-only system reads are never exposed as a user or collector read API.
 */
public without sharing class ChoiceDefinitionHandler {
    public static void validateLists(
        List<Choice_List__c> lists,
        Map<Id, Choice_List__c> oldLists
    ) {
        Set<Id> ownerIds = new Set<Id>();
        for (Choice_List__c listRecord : lists) {
            if (oldLists != null) {
                if (
                    listRecord.Owner_Question__c !=
                    oldLists.get(listRecord.Id).Owner_Question__c
                ) {
                    listRecord.addError(
                        'Inline choice-list ownership cannot change; create a new list.'
                    );
                }
            } else if (listRecord.Owner_Question__c != null) {
                ownerIds.add(listRecord.Owner_Question__c);
            }
        }
        if (ownerIds.isEmpty())
            return;
        // A question type change and a new inline-list owner cannot race each other.
        Map<Id, Question__c> owners = new Map<Id, Question__c>(
            [
                SELECT Id, Type__c
                FROM Question__c
                WHERE Id IN :ownerIds
                FOR UPDATE
            ]
        );
        for (Choice_List__c listRecord : lists) {
            if (listRecord.Owner_Question__c == null)
                continue;
            Question__c owner = owners.get(listRecord.Owner_Question__c);
            if (
                owner == null ||
                (owner.Type__c != 'select_one' &&
                owner.Type__c != 'select_multiple')
            ) {
                listRecord.addError(
                    'An inline choice list must belong to a select question.'
                );
            }
        }
    }

    public static void assignChoiceKeys(List<Choice__c> choices) {
        for (Choice__c choice : choices) {
            choice.Choice_Key__c = null;
            if (String.isBlank(choice.Label__c)) {
                choice.addError('Choice Label must contain text.');
            }
            if (
                choice.Choice_List__c != null &&
                !String.isBlank(choice.Value__c)
            ) {
                choice.Choice_Key__c = EncodingUtil.convertToHex(
                    Crypto.generateDigest(
                        'SHA-256',
                        Blob.valueOf(
                            String.valueOf(choice.Choice_List__c) +
                                ':' +
                                choice.Value__c
                        )
                    )
                );
            }
        }
    }
}
