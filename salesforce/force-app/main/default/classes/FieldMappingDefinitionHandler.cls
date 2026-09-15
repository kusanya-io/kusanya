/**
 * Responsibility: validate stored field-mapping ownership and source selection,
 * and derive case-insensitive target uniqueness within each mapping.
 * Trigger-only integrity reads include hidden definitions; this is not a reader,
 * schema/FLS validator, transform evaluator, publisher or target-record writer.
 */
public without sharing class FieldMappingDefinitionHandler {
    private static final Pattern TARGET_NAME = Pattern.compile(
        '^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$'
    );
    private static final String INVALID = 'Field mapping is inconsistent. Check its owner, target field and question-or-constant source.';

    public static void validateFields(
        List<Field_Mapping__c> incoming,
        Map<Id, Field_Mapping__c> original
    ) {
        Set<Id> mappingIds = new Set<Id>();
        Set<Id> questionIds = new Set<Id>();
        for (Field_Mapping__c field : incoming) {
            field.Target_Key__c = null;
            mappingIds.add(field.Mapping__c);
            questionIds.add(field.Question__c);
        }
        mappingIds.remove(null);
        questionIds.remove(null);
        // Owners cannot be reparented. Locks also serialize referenced deletion
        // with a new field mapping; no dependency is silently cleared on save.
        Map<Id, Mapping__c> mappings = new Map<Id, Mapping__c>(
            [
                SELECT Id, Form_Version__c
                FROM Mapping__c
                WHERE Id IN :mappingIds
                FOR UPDATE
            ]
        );
        Map<Id, Question__c> questions = new Map<Id, Question__c>(
            [
                SELECT Id, Form_Version__c
                FROM Question__c
                WHERE Id IN :questionIds
                FOR UPDATE
            ]
        );
        for (Field_Mapping__c field : incoming) {
            Mapping__c owner = mappings.get(field.Mapping__c);
            Question__c question = questions.get(field.Question__c);
            Boolean valid =
                owner != null &&
                field.Target_Field__c != null &&
                TARGET_NAME.matcher(field.Target_Field__c).matches() &&
                (original == null ||
                original.get(field.Id).Mapping__c == field.Mapping__c);
            if (field.Source_Kind__c == 'question') {
                valid =
                    valid &&
                    question != null &&
                    question.Form_Version__c == owner?.Form_Version__c &&
                    String.isEmpty(field.Constant_Value__c);
            } else if (field.Source_Kind__c == 'constant') {
                // Salesforce can normalize an empty string to null. The explicit
                // discriminator preserves the intent to supply a blank constant.
                valid = valid && field.Question__c == null;
            } else {
                valid = false;
            }
            if (!valid) {
                field.addError(INVALID);
                continue;
            }
            field.Target_Key__c = EncodingUtil.convertToHex(
                Crypto.generateDigest(
                    'SHA-256',
                    Blob.valueOf(
                        String.valueOf(field.Mapping__c) +
                            ':' +
                            field.Target_Field__c.toLowerCase()
                    )
                )
            );
        }
    }
}
