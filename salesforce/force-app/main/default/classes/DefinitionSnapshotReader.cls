/**
 * Responsibility: read one bounded form-version definition as portable compiler input.
 * Salesforce IDs resolve relationships internally and never enter the returned bundle.
 * Sharing, CRUD and FLS are enforced by with-sharing queries in user mode.
 * This class does not expose an endpoint, compile, publish, mutate or read target data.
 */
public with sharing class DefinitionSnapshotReader {
    private static final Integer QUESTION_LIMIT = 500;
    private static final Integer CHOICE_LIST_LIMIT = 500;
    private static final Integer CHOICE_LIMIT = 5000;
    private static final Integer SKIP_RULE_LIMIT = 2000;
    private static final Integer MAPPING_LIMIT = 100;
    private static final Integer FIELD_MAPPING_LIMIT = 2000;

    public class RefusedException extends Exception {
    }

    public static Map<String, Object> readVersion(Id versionId) {
        if (
            versionId == null ||
            versionId.getSObjectType() != Form_Version__c.SObjectType
        ) {
            refuse();
        }

        List<Form_Version__c> versions;
        try {
            versions = [
                SELECT Id, Version_Number__c, Form__r.Name
                FROM Form_Version__c
                WHERE Id = :versionId
                WITH USER_MODE
                LIMIT 1
            ];
        } catch (Exception ignored) {
            refuse();
            return null;
        }
        if (versions.size() != 1) {
            refuse();
        }
        Form_Version__c version = versions[0];
        Integer questionQueryLimit = QUESTION_LIMIT + 1;
        Integer skipRuleQueryLimit = SKIP_RULE_LIMIT + 1;
        Integer mappingQueryLimit = MAPPING_LIMIT + 1;
        Integer choiceListQueryLimit = CHOICE_LIST_LIMIT + 1;
        Integer choiceQueryLimit = CHOICE_LIMIT + 1;
        Integer fieldMappingQueryLimit = FIELD_MAPPING_LIMIT + 1;

        List<Question__c> questions;
        List<Skip_Rule__c> rules;
        List<Mapping__c> mappings;
        try {
            questions = [
                SELECT
                    Id,
                    Name,
                    Parent__r.Name,
                    Order__c,
                    Type__c,
                    Label__c,
                    Hint__c,
                    Author_Notes__c,
                    Required__c,
                    Read_Only__c,
                    Hidden__c,
                    Default_Value__c,
                    Calculation__c,
                    Constraint__c,
                    Constraint_Message__c,
                    Regex__c,
                    Regex_Example__c,
                    Minimum__c,
                    Maximum__c,
                    Relevant__c,
                    Appearance__c,
                    Choice_List__c,
                    Repeat_Mode__c,
                    Repeat_Count__c,
                    Repeat_Source_Question__r.Name,
                    Repeat_Max__c,
                    Same_Page__c,
                    Repeat_As_Table__c,
                    Cascade_Level__c,
                    Require_Live_Photo__c,
                    Media_Max_Seconds__c,
                    Prefill_Source__c,
                    Validation_Script__c
                FROM Question__c
                WHERE Form_Version__c = :versionId
                WITH USER_MODE
                ORDER BY Order__c, Name, Id
                LIMIT :questionQueryLimit
            ];
            rules = [
                SELECT
                    Question__r.Name,
                    Source_Question__r.Name,
                    Operator__c,
                    Value__c,
                    Value_To__c,
                    Join__c,
                    Action__c
                FROM Skip_Rule__c
                WHERE Question__r.Form_Version__c = :versionId
                WITH USER_MODE
                ORDER BY Question__r.Name, Source_Question__r.Name, Id
                LIMIT :skipRuleQueryLimit
            ];
            mappings = [
                SELECT
                    Id,
                    Name,
                    Order__c,
                    Kind__c,
                    Target_Object__c,
                    Repeat_Question__r.Name,
                    Record_Type__c,
                    Parent_Mapping__c,
                    Parent_Lookup_Field__c,
                    Matching_Field__c,
                    Upsert_External_Id_Field__c,
                    Collector_Field__c,
                    Submission_Field__c
                FROM Mapping__c
                WHERE Form_Version__c = :versionId
                WITH USER_MODE
                ORDER BY Order__c, Name, Id
                LIMIT :mappingQueryLimit
            ];
        } catch (Exception ignored) {
            refuse();
            return null;
        }
        bounded(questions.size(), QUESTION_LIMIT);
        bounded(rules.size(), SKIP_RULE_LIMIT);
        bounded(mappings.size(), MAPPING_LIMIT);

        Set<Id> choiceListIds = new Set<Id>();
        for (Question__c question : questions) {
            if (question.Choice_List__c != null) {
                choiceListIds.add(question.Choice_List__c);
            }
        }
        bounded(choiceListIds.size(), CHOICE_LIST_LIMIT);

        List<Choice_List__c> choiceLists = new List<Choice_List__c>();
        List<Choice__c> choices = new List<Choice__c>();
        if (!choiceListIds.isEmpty()) {
            try {
                choiceLists = [
                    SELECT Id, Name
                    FROM Choice_List__c
                    WHERE Id IN :choiceListIds
                    WITH USER_MODE
                    ORDER BY Name, Id
                    LIMIT :choiceListQueryLimit
                ];
                choices = [
                    SELECT
                        Choice_List__c,
                        Value__c,
                        Label__c,
                        Order__c,
                        Filter_Value__c,
                        Score__c
                    FROM Choice__c
                    WHERE Choice_List__c IN :choiceListIds
                    WITH USER_MODE
                    ORDER BY Choice_List__c, Order__c, Value__c, Id
                    LIMIT :choiceQueryLimit
                ];
            } catch (Exception ignored) {
                refuse();
            }
        }
        bounded(choiceLists.size(), CHOICE_LIST_LIMIT);
        bounded(choices.size(), CHOICE_LIMIT);
        if (choiceLists.size() != choiceListIds.size()) {
            refuse();
        }

        Set<Id> mappingIds = new Set<Id>();
        for (Mapping__c mapping : mappings) {
            mappingIds.add(mapping.Id);
        }
        List<Field_Mapping__c> fields = new List<Field_Mapping__c>();
        if (!mappingIds.isEmpty()) {
            try {
                fields = [
                    SELECT
                        Mapping__c,
                        Target_Field__c,
                        Transform__c,
                        Source_Kind__c,
                        Question__r.Name,
                        Constant_Value__c
                    FROM Field_Mapping__c
                    WHERE Mapping__c IN :mappingIds
                    WITH USER_MODE
                    ORDER BY Mapping__c, Target_Field__c, Id
                    LIMIT :fieldMappingQueryLimit
                ];
            } catch (Exception ignored) {
                refuse();
            }
        }
        bounded(fields.size(), FIELD_MAPPING_LIMIT);

        Map<Id, String> listKeys = new Map<Id, String>();
        Integer listIndex = 0;
        for (Choice_List__c listDefinition : choiceLists) {
            listIndex++;
            listKeys.put(listDefinition.Id, 'choice_list_' + listIndex);
        }
        Map<Id, List<Map<String, Object>>> choicesByList = new Map<Id, List<Map<String, Object>>>();
        for (Choice_List__c listDefinition : choiceLists) {
            choicesByList.put(
                listDefinition.Id,
                new List<Map<String, Object>>()
            );
        }
        for (Choice__c choice : choices) {
            Map<String, Object> output = new Map<String, Object>{
                'value' => choice.Value__c,
                'label' => choice.Label__c,
                'order' => choice.Order__c
            };
            optional(output, 'filterValue', choice.Filter_Value__c);
            optional(output, 'score', choice.Score__c);
            choicesByList.get(choice.Choice_List__c).add(output);
        }

        List<Map<String, Object>> outputQuestions = new List<Map<String, Object>>();
        for (Question__c question : questions) {
            Map<String, Object> output = new Map<String, Object>{
                'name' => question.Name,
                'order' => question.Order__c,
                'type' => question.Type__c,
                'required' => question.Required__c,
                'readOnly' => question.Read_Only__c,
                'hidden' => question.Hidden__c,
                'samePage' => question.Same_Page__c,
                'repeatAsTable' => question.Repeat_As_Table__c,
                'requireLivePhoto' => question.Require_Live_Photo__c
            };
            optional(output, 'parent', relationshipName(question, 'Parent__r'));
            optional(output, 'label', question.Label__c);
            optional(output, 'hint', question.Hint__c);
            optional(output, 'authorNotes', question.Author_Notes__c);
            optional(output, 'defaultValue', question.Default_Value__c);
            optional(output, 'calculation', question.Calculation__c);
            optional(output, 'constraint', question.Constraint__c);
            optional(
                output,
                'constraintMessage',
                question.Constraint_Message__c
            );
            optional(output, 'regex', question.Regex__c);
            optional(output, 'regexExample', question.Regex_Example__c);
            optional(output, 'minimum', question.Minimum__c);
            optional(output, 'maximum', question.Maximum__c);
            optional(output, 'relevant', question.Relevant__c);
            optional(output, 'appearance', question.Appearance__c);
            if (question.Choice_List__c != null) {
                output.put('choiceList', listKeys.get(question.Choice_List__c));
            }
            optional(output, 'repeatMode', question.Repeat_Mode__c);
            optional(output, 'repeatCount', question.Repeat_Count__c);
            optional(
                output,
                'repeatSourceQuestion',
                relationshipName(question, 'Repeat_Source_Question__r')
            );
            optional(output, 'repeatMax', question.Repeat_Max__c);
            optional(output, 'cascadeLevel', question.Cascade_Level__c);
            optional(output, 'mediaMaxSeconds', question.Media_Max_Seconds__c);
            optional(output, 'prefillSource', question.Prefill_Source__c);
            optional(output, 'validationScript', question.Validation_Script__c);
            outputQuestions.add(output);
        }

        List<Map<String, Object>> outputLists = new List<Map<String, Object>>();
        for (Choice_List__c listDefinition : choiceLists) {
            outputLists.add(
                new Map<String, Object>{
                    'name' => listKeys.get(listDefinition.Id),
                    'choices' => choicesByList.get(listDefinition.Id)
                }
            );
        }

        List<Map<String, Object>> outputRules = new List<Map<String, Object>>();
        for (Skip_Rule__c rule : rules) {
            Map<String, Object> output = new Map<String, Object>{
                'question' => relationshipName(rule, 'Question__r'),
                'sourceQuestion' => relationshipName(
                    rule,
                    'Source_Question__r'
                ),
                'operator' => rule.Operator__c,
                'join' => rule.Join__c,
                'action' => rule.Action__c
            };
            optional(output, 'value', rule.Value__c);
            optional(output, 'valueTo', rule.Value_To__c);
            outputRules.add(output);
        }

        Map<Id, String> mappingKeys = new Map<Id, String>();
        Integer mappingIndex = 0;
        for (Mapping__c mapping : mappings) {
            mappingIndex++;
            mappingKeys.put(mapping.Id, 'mapping_' + mappingIndex);
        }
        Map<Id, List<Map<String, Object>>> fieldsByMapping = new Map<Id, List<Map<String, Object>>>();
        for (Mapping__c mapping : mappings) {
            fieldsByMapping.put(mapping.Id, new List<Map<String, Object>>());
        }
        for (Field_Mapping__c field : fields) {
            Map<String, Object> output = new Map<String, Object>{
                'targetField' => field.Target_Field__c,
                'transform' => field.Transform__c,
                'sourceKind' => field.Source_Kind__c
            };
            if (field.Source_Kind__c == 'question') {
                output.put('question', relationshipName(field, 'Question__r'));
            } else {
                output.put('constantValue', field.Constant_Value__c);
            }
            fieldsByMapping.get(field.Mapping__c).add(output);
        }

        List<Map<String, Object>> outputMappings = new List<Map<String, Object>>();
        for (Mapping__c mapping : mappings) {
            Map<String, Object> output = new Map<String, Object>{
                'key' => mappingKeys.get(mapping.Id),
                'label' => mapping.Name,
                'order' => mapping.Order__c,
                'kind' => mapping.Kind__c,
                'targetObject' => mapping.Target_Object__c,
                'fields' => fieldsByMapping.get(mapping.Id)
            };
            optional(
                output,
                'repeatQuestion',
                relationshipName(mapping, 'Repeat_Question__r')
            );
            optional(output, 'recordType', mapping.Record_Type__c);
            if (mapping.Parent_Mapping__c != null) {
                if (!mappingKeys.containsKey(mapping.Parent_Mapping__c)) {
                    refuse();
                }
                output.put(
                    'parentMapping',
                    mappingKeys.get(mapping.Parent_Mapping__c)
                );
            }
            optional(
                output,
                'parentLookupField',
                mapping.Parent_Lookup_Field__c
            );
            optional(output, 'matchingField', mapping.Matching_Field__c);
            optional(
                output,
                'upsertExternalIdField',
                mapping.Upsert_External_Id_Field__c
            );
            optional(output, 'collectorField', mapping.Collector_Field__c);
            optional(output, 'submissionField', mapping.Submission_Field__c);
            outputMappings.add(output);
        }

        String formKey =
            'form_' +
            EncodingUtil.convertToHex(
                    Crypto.generateDigest(
                        'SHA-256',
                        Blob.valueOf(String.valueOf(version.Id))
                    )
                )
                .substring(0, 32);
        return new Map<String, Object>{
            'schemaVersion' => 1,
            'definition' => new Map<String, Object>{
                'schemaVersion' => 1,
                'form' => new Map<String, Object>{
                    'key' => formKey,
                    'title' => version.Form__r.Name,
                    'version' => version.Version_Number__c
                },
                'questions' => outputQuestions,
                'choiceLists' => outputLists,
                'skipRules' => outputRules
            },
            'mappingBundle' => new Map<String, Object>{
                'schemaVersion' => 1,
                'mappings' => outputMappings
            }
        };
    }

    private static String relationshipName(
        SObject record,
        String relationship
    ) {
        SObject related = record.getSObject(relationship);
        return related == null ? null : (String) related.get('Name');
    }

    private static void optional(
        Map<String, Object> output,
        String key,
        Object value
    ) {
        if (value != null) {
            output.put(key, value);
        }
    }

    private static void bounded(Integer count, Integer limitValue) {
        if (count > limitValue) {
            refuse();
        }
    }

    private static void refuse() {
        throw new RefusedException('DEFINITION_SNAPSHOT_REFUSED');
    }
}
