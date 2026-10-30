/**
 * Responsibility: validate and atomically persist one bounded portable draft
 * definition graph received through the integration-only import resource.
 * User-mode DML enforces CRUD/FLS. Portable names resolve relationships; no
 * caller-supplied Salesforce identifier, publication, target read or collector
 * Salesforce access is accepted or created.
 */
public with sharing class DefinitionImportService {
    private static final Integer QUESTION_LIMIT = 500;
    private static final Integer CHOICE_LIST_LIMIT = 500;
    private static final Integer CHOICE_LIMIT = 5000;
    private static final Integer SKIP_RULE_LIMIT = 2000;
    private static final Integer MAPPING_LIMIT = 100;
    private static final Integer FIELD_MAPPING_LIMIT = 2000;
    private static final Pattern PORTABLE_NAME = Pattern.compile(
        '^[A-Za-z_][A-Za-z0-9_.-]*$'
    );
    private static final Pattern API_NAME = Pattern.compile(
        '^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$'
    );

    public class RefusedException extends Exception {
    }

    public class ImportEnvelope {
        public Integer schemaVersion;
        public DefinitionInput definition;
        public MappingBundleInput mappingBundle;
    }
    public class DefinitionInput {
        public Integer schemaVersion;
        public FormInput form;
        public List<QuestionInput> questions;
        public List<ChoiceListInput> choiceLists;
        public List<SkipRuleInput> skipRules;
    }
    public class FormInput {
        public String key;
        public String title;
        public Integer version;
    }
    public class QuestionInput {
        public String name;
        public String parent;
        public Integer order;
        public String type;
        public String label;
        public String hintValue;
        public String authorNotes;
        public Boolean required;
        public Boolean readOnly;
        public Boolean hidden;
        public String defaultValue;
        public String calculation;
        public String constraint;
        public String constraintMessage;
        public String regex;
        public String regexExample;
        public Decimal minimum;
        public Decimal maximum;
        public String relevant;
        public String appearance;
        public String choiceList;
        public String repeatMode;
        public Integer repeatCount;
        public String repeatSourceQuestion;
        public Integer repeatMax;
        public Boolean samePage;
        public Boolean repeatAsTable;
        public Integer cascadeLevel;
        public Boolean requireLivePhoto;
        public Integer mediaMaxSeconds;
        public String prefillSource;
        public String validationScript;
    }
    public class ChoiceListInput {
        public String name;
        public List<ChoiceInput> choices;
    }
    public class ChoiceInput {
        public String value;
        public String label;
        public Integer order;
        public String filterValue;
        public Decimal score;
    }
    public class SkipRuleInput {
        public String question;
        public String sourceQuestion;
        public String operator;
        public String value;
        public String valueTo;
        public String joinValue;
        public String action;
    }
    public class MappingBundleInput {
        public Integer schemaVersion;
        public List<MappingInput> mappings;
    }
    public class MappingInput {
        public String key;
        public String label;
        public Integer order;
        public String kind;
        public String targetObject;
        public String repeatQuestion;
        public String recordType;
        public String parentMapping;
        public String parentLookupField;
        public String matchingField;
        public String upsertExternalIdField;
        public String collectorField;
        public String submissionField;
        public List<FieldInput> fields;
    }
    public class FieldInput {
        public String targetField;
        public String transform;
        public String sourceKind;
        public String question;
        public String constantValue;
    }

    public static Id importDefinition(ImportEnvelope input) {
        try {
            validate(input);
        } catch (Exception error) {
            refuse();
        }
        Savepoint checkpoint = Database.setSavepoint();
        try {
            Form__c form = new Form__c(
                Name = input.definition.form.title,
                Status__c = 'Draft'
            );
            Database.insert(
                new List<Form__c>{ form },
                true,
                AccessLevel.USER_MODE
            );
            Form_Version__c version = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = input.definition.form.version,
                Status__c = 'Draft'
            );
            Database.insert(
                new List<Form_Version__c>{ version },
                true,
                AccessLevel.USER_MODE
            );

            Map<String, Id> listIds = insertChoiceLists(
                input.definition.choiceLists
            );
            Map<String, Id> questionIds = insertQuestions(
                version.Id,
                input.definition.questions,
                listIds
            );
            insertChoices(input.definition.choiceLists, listIds);
            insertSkipRules(input.definition.skipRules, questionIds);
            Map<String, Id> mappingIds = insertMappings(
                version.Id,
                input.mappingBundle.mappings,
                questionIds
            );
            insertFields(input.mappingBundle.mappings, mappingIds, questionIds);
            return version.Id;
        } catch (Exception error) {
            Database.rollback(checkpoint);
            refuse();
            return null;
        }
    }

    private static Map<String, Id> insertChoiceLists(
        List<ChoiceListInput> definitions
    ) {
        List<Choice_List__c> records = new List<Choice_List__c>();
        for (ChoiceListInput definition : definitions) {
            records.add(new Choice_List__c(Name = definition.name));
        }
        if (!records.isEmpty()) {
            Database.insert(records, true, AccessLevel.USER_MODE);
        }
        Map<String, Id> result = new Map<String, Id>();
        for (Integer index = 0; index < records.size(); index++) {
            result.put(definitions[index].name, records[index].Id);
        }
        return result;
    }

    private static Map<String, Id> insertQuestions(
        Id versionId,
        List<QuestionInput> definitions,
        Map<String, Id> listIds
    ) {
        List<QuestionInput> pending = new List<QuestionInput>(definitions);
        Map<String, Id> result = new Map<String, Id>();
        while (!pending.isEmpty()) {
            List<QuestionInput> ready = new List<QuestionInput>();
            for (QuestionInput definition : pending) {
                if (
                    (definition.parent == null ||
                    result.containsKey(definition.parent)) &&
                    (definition.repeatSourceQuestion == null ||
                    result.containsKey(definition.repeatSourceQuestion))
                ) {
                    ready.add(definition);
                }
            }
            if (ready.isEmpty())
                refuse();
            List<Question__c> records = new List<Question__c>();
            for (QuestionInput definition : ready) {
                records.add(
                    new Question__c(
                        Name = definition.name,
                        Form_Version__c = versionId,
                        Parent__c = result.get(definition.parent),
                        Order__c = definition.order,
                        Type__c = definition.type,
                        Label__c = definition.label,
                        Hint__c = definition.hintValue,
                        Author_Notes__c = definition.authorNotes,
                        Required__c = definition.required == true,
                        Read_Only__c = definition.readOnly == true,
                        Hidden__c = definition.hidden == true,
                        Default_Value__c = definition.defaultValue,
                        Calculation__c = definition.calculation,
                        Constraint__c = definition.constraint,
                        Constraint_Message__c = definition.constraintMessage,
                        Regex__c = definition.regex,
                        Regex_Example__c = definition.regexExample,
                        Minimum__c = definition.minimum,
                        Maximum__c = definition.maximum,
                        Relevant__c = definition.relevant,
                        Appearance__c = definition.appearance,
                        Choice_List__c = listIds.get(definition.choiceList),
                        Repeat_Mode__c = definition.repeatMode,
                        Repeat_Count__c = definition.repeatCount,
                        Repeat_Source_Question__c = result.get(
                            definition.repeatSourceQuestion
                        ),
                        Repeat_Max__c = definition.repeatMax,
                        Same_Page__c = definition.samePage == true,
                        Repeat_As_Table__c = definition.repeatAsTable == true,
                        Cascade_Level__c = definition.cascadeLevel,
                        Require_Live_Photo__c = definition.requireLivePhoto ==
                            true,
                        Media_Max_Seconds__c = definition.mediaMaxSeconds,
                        Prefill_Source__c = definition.prefillSource,
                        Validation_Script__c = definition.validationScript
                    )
                );
            }
            Database.insert(records, true, AccessLevel.USER_MODE);
            for (Integer index = 0; index < records.size(); index++) {
                result.put(ready[index].name, records[index].Id);
            }
            Set<String> insertedNames = new Set<String>();
            for (QuestionInput definition : ready) {
                insertedNames.add(definition.name);
            }
            List<QuestionInput> remaining = new List<QuestionInput>();
            for (QuestionInput definition : pending) {
                if (!insertedNames.contains(definition.name)) {
                    remaining.add(definition);
                }
            }
            pending = remaining;
        }
        return result;
    }

    private static void insertChoices(
        List<ChoiceListInput> definitions,
        Map<String, Id> listIds
    ) {
        List<Choice__c> records = new List<Choice__c>();
        for (ChoiceListInput listDefinition : definitions) {
            for (ChoiceInput definition : listDefinition.choices) {
                records.add(
                    new Choice__c(
                        Choice_List__c = listIds.get(listDefinition.name),
                        Value__c = definition.value,
                        Label__c = definition.label,
                        Order__c = definition.order,
                        Filter_Value__c = definition.filterValue,
                        Score__c = definition.score
                    )
                );
            }
        }
        if (!records.isEmpty()) {
            Database.insert(records, true, AccessLevel.USER_MODE);
        }
    }

    private static void insertSkipRules(
        List<SkipRuleInput> definitions,
        Map<String, Id> questionIds
    ) {
        List<Skip_Rule__c> records = new List<Skip_Rule__c>();
        for (SkipRuleInput definition : definitions) {
            records.add(
                new Skip_Rule__c(
                    Question__c = questionIds.get(definition.question),
                    Source_Question__c = questionIds.get(
                        definition.sourceQuestion
                    ),
                    Operator__c = definition.operator,
                    Value__c = definition.value,
                    Value_To__c = definition.valueTo,
                    Join__c = definition.joinValue,
                    Action__c = definition.action
                )
            );
        }
        if (!records.isEmpty()) {
            Database.insert(records, true, AccessLevel.USER_MODE);
        }
    }

    private static Map<String, Id> insertMappings(
        Id versionId,
        List<MappingInput> definitions,
        Map<String, Id> questionIds
    ) {
        List<MappingInput> pending = new List<MappingInput>(definitions);
        Map<String, Id> result = new Map<String, Id>();
        while (!pending.isEmpty()) {
            List<MappingInput> ready = new List<MappingInput>();
            for (MappingInput definition : pending) {
                if (
                    definition.parentMapping == null ||
                    result.containsKey(definition.parentMapping)
                ) {
                    ready.add(definition);
                }
            }
            if (ready.isEmpty())
                refuse();
            List<Mapping__c> records = new List<Mapping__c>();
            for (MappingInput definition : ready) {
                records.add(
                    new Mapping__c(
                        Name = definition.label == null
                            ? definition.key
                            : definition.label,
                        Form_Version__c = versionId,
                        Order__c = definition.order,
                        Kind__c = definition.kind,
                        Target_Object__c = definition.targetObject,
                        Repeat_Question__c = questionIds.get(
                            definition.repeatQuestion
                        ),
                        Record_Type__c = definition.recordType,
                        Parent_Mapping__c = result.get(
                            definition.parentMapping
                        ),
                        Parent_Lookup_Field__c = definition.parentLookupField,
                        Matching_Field__c = definition.matchingField,
                        Upsert_External_Id_Field__c = definition.upsertExternalIdField,
                        Collector_Field__c = definition.collectorField,
                        Submission_Field__c = definition.submissionField
                    )
                );
            }
            Database.insert(records, true, AccessLevel.USER_MODE);
            for (Integer index = 0; index < records.size(); index++) {
                result.put(ready[index].key, records[index].Id);
            }
            Set<String> insertedKeys = new Set<String>();
            for (MappingInput definition : ready) {
                insertedKeys.add(definition.key);
            }
            List<MappingInput> remaining = new List<MappingInput>();
            for (MappingInput definition : pending) {
                if (!insertedKeys.contains(definition.key)) {
                    remaining.add(definition);
                }
            }
            pending = remaining;
        }
        return result;
    }

    private static void insertFields(
        List<MappingInput> definitions,
        Map<String, Id> mappingIds,
        Map<String, Id> questionIds
    ) {
        List<Field_Mapping__c> records = new List<Field_Mapping__c>();
        for (MappingInput mapping : definitions) {
            for (FieldInput definition : mapping.fields) {
                records.add(
                    new Field_Mapping__c(
                        Mapping__c = mappingIds.get(mapping.key),
                        Target_Field__c = definition.targetField,
                        Transform__c = definition.transform == null
                            ? 'none'
                            : definition.transform,
                        Source_Kind__c = definition.sourceKind,
                        Question__c = questionIds.get(definition.question),
                        Constant_Value__c = definition.constantValue
                    )
                );
            }
        }
        if (!records.isEmpty()) {
            Database.insert(records, true, AccessLevel.USER_MODE);
        }
    }

    private static void validate(ImportEnvelope input) {
        if (
            input == null ||
            input.schemaVersion != 1 ||
            input.definition == null ||
            input.mappingBundle == null ||
            input.definition.schemaVersion != 1 ||
            input.mappingBundle.schemaVersion != 1 ||
            input.definition.form == null ||
            input.definition.questions == null ||
            input.definition.choiceLists == null ||
            input.definition.skipRules == null ||
            input.mappingBundle.mappings == null ||
            input.definition.questions.size() > QUESTION_LIMIT ||
            input.definition.choiceLists.size() > CHOICE_LIST_LIMIT ||
            input.definition.skipRules.size() > SKIP_RULE_LIMIT ||
            input.mappingBundle.mappings.size() > MAPPING_LIMIT
        ) {
            refuse();
        }
        FormInput form = input.definition.form;
        portable(form.key, 80);
        requiredText(form.title, 80);
        if (
            form.version == null ||
            form.version <= 0 ||
            form.version > 999999999
        )
            refuse();

        Set<String> questionNames = new Set<String>();
        for (QuestionInput question : input.definition.questions) {
            portable(question.name, 80);
            if (questionNames.contains(question.name))
                refuse();
            questionNames.add(question.name);
            if (
                question.order == null ||
                question.order <= 0 ||
                question.order > 999999999 ||
                String.isBlank(question.type)
            )
                refuse();
            optionalText(question.label, 32768);
            optionalText(question.hintValue, 32768);
            optionalText(question.authorNotes, 32768);
            optionalText(question.defaultValue, 32768);
            optionalText(question.calculation, 32768);
            optionalText(question.constraint, 32768);
            optionalText(question.constraintMessage, 32768);
            optionalText(question.regex, 32768);
            optionalText(question.regexExample, 32768);
            optionalText(question.relevant, 32768);
            optionalText(question.validationScript, 32768);
            optionalText(question.appearance, 255);
            optionalText(question.prefillSource, 255);
        }
        Set<String> listNames = new Set<String>();
        Integer choiceCount = 0;
        for (ChoiceListInput listDefinition : input.definition.choiceLists) {
            portable(listDefinition.name, 80);
            if (
                listNames.contains(listDefinition.name) ||
                listDefinition.choices == null
            )
                refuse();
            listNames.add(listDefinition.name);
            Set<String> values = new Set<String>();
            for (ChoiceInput choice : listDefinition.choices) {
                choiceCount++;
                requiredText(choice.value, 255);
                requiredText(choice.label, 32768);
                if (
                    values.contains(choice.value) ||
                    choice.order == null ||
                    choice.order <= 0 ||
                    choice.order > 999999999
                )
                    refuse();
                values.add(choice.value);
                optionalText(choice.filterValue, 255);
            }
        }
        if (choiceCount > CHOICE_LIMIT)
            refuse();
        for (QuestionInput question : input.definition.questions) {
            if (
                (question.parent != null &&
                !questionNames.contains(question.parent)) ||
                (question.repeatSourceQuestion != null &&
                !questionNames.contains(question.repeatSourceQuestion)) ||
                (question.choiceList != null &&
                !listNames.contains(question.choiceList))
            )
                refuse();
        }
        for (SkipRuleInput rule : input.definition.skipRules) {
            if (
                rule == null ||
                !questionNames.contains(rule.question) ||
                !questionNames.contains(rule.sourceQuestion)
            )
                refuse();
        }
        Set<String> mappingKeys = new Set<String>();
        Integer fieldCount = 0;
        for (MappingInput mapping : input.mappingBundle.mappings) {
            portable(mapping.key, 80);
            if (
                mappingKeys.contains(mapping.key) ||
                mapping.order == null ||
                mapping.order <= 0 ||
                mapping.order > 999999999 ||
                mapping.fields == null
            )
                refuse();
            mappingKeys.add(mapping.key);
            optionalText(mapping.label, 80);
            apiName(mapping.targetObject);
            optionalApiName(mapping.recordType);
            optionalApiName(mapping.parentLookupField);
            optionalApiName(mapping.matchingField);
            optionalApiName(mapping.upsertExternalIdField);
            optionalApiName(mapping.collectorField);
            optionalApiName(mapping.submissionField);
            for (FieldInput field : mapping.fields) {
                fieldCount++;
                apiName(field.targetField);
                optionalText(field.constantValue, 32768);
            }
        }
        if (fieldCount > FIELD_MAPPING_LIMIT)
            refuse();
        for (MappingInput mapping : input.mappingBundle.mappings) {
            if (
                (mapping.parentMapping != null &&
                !mappingKeys.contains(mapping.parentMapping)) ||
                (mapping.repeatQuestion != null &&
                !questionNames.contains(mapping.repeatQuestion))
            )
                refuse();
            for (FieldInput field : mapping.fields) {
                if (
                    field == null ||
                    (field.question != null &&
                    !questionNames.contains(field.question))
                )
                    refuse();
            }
        }
    }

    private static void portable(String value, Integer limitValue) {
        if (
            String.isBlank(value) ||
            value.length() > limitValue ||
            !PORTABLE_NAME.matcher(value).matches()
        )
            refuse();
    }
    private static void requiredText(String value, Integer limitValue) {
        if (String.isBlank(value) || value.length() > limitValue)
            refuse();
    }
    private static void optionalText(String value, Integer limitValue) {
        if (value != null && value.length() > limitValue)
            refuse();
    }
    private static void apiName(String value) {
        if (value == null || !API_NAME.matcher(value).matches())
            refuse();
    }
    private static void optionalApiName(String value) {
        if (value != null)
            apiName(value);
    }
    private static void refuse() {
        throw new RefusedException('DEFINITION_IMPORT_REFUSED');
    }
}
