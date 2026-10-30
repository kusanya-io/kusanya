/**
 * Responsibility: prove the definition import boundary is integration-only,
 * bounded, atomic and lossless for the portable definition graph. Synthetic
 * records only; no publication, customer target or C10 acceptance claim.
 */
@IsTest
private class DefinitionImportResourceTest {
    @IsTest
    static void atomicallyImportsACompletePortableGraph() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('importok');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            RestResponse response = invoke(
                'POST',
                'application/json',
                JSON.serialize(sample())
            );
            Assert.areEqual(201, response.statusCode);
            Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(
                response.responseBody.toString()
            );
            Id versionId = Id.valueOf((String) result.get('formVersionId'));
            Assert.areEqual(
                Form_Version__c.SObjectType,
                versionId.getSObjectType()
            );
            Assert.areEqual(1, [SELECT COUNT() FROM Form__c]);
            Assert.areEqual(1, [SELECT COUNT() FROM Form_Version__c]);
            Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
            Assert.areEqual(1, [SELECT COUNT() FROM Choice_List__c]);
            Assert.areEqual(2, [SELECT COUNT() FROM Choice__c]);
            Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
            Assert.areEqual(2, [SELECT COUNT() FROM Mapping__c]);
            Assert.areEqual(2, [SELECT COUNT() FROM Field_Mapping__c]);

            Map<String, Object> snapshot = DefinitionSnapshotReader.readVersion(
                versionId
            );
            Map<String, Object> definition = (Map<String, Object>) snapshot.get(
                'definition'
            );
            List<Object> questions = (List<Object>) definition.get('questions');
            Assert.areEqual(3, questions.size());
            List<Object> lists = (List<Object>) definition.get('choiceLists');
            Assert.areEqual(
                'yes_no',
                ((Map<String, Object>) lists[0]).get('name')
            );
            String serialized = JSON.serialize(snapshot);
            Assert.isFalse(serialized.contains(String.valueOf(versionId)));
            Assert.isTrue(serialized.contains('AUTHOR_ONLY_IMPORT_SENTINEL'));
        }
    }

    @IsTest
    static void rollsBackEveryRecordWhenALateDefinitionFails() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('rollback');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            DefinitionImportService.ImportEnvelope invalid = sample();
            invalid.definition.questions[2].type = 'not_a_type';
            RestResponse response = invoke(
                'POST',
                'application/json',
                JSON.serialize(invalid)
            );
            Assert.areEqual(400, response.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"error":"DEFINITION_IMPORT_REFUSED"}',
                response.responseBody.toString()
            );
            Assert.areEqual(0, [SELECT COUNT() FROM Form__c]);
            Assert.areEqual(0, [SELECT COUNT() FROM Form_Version__c]);
            Assert.areEqual(0, [SELECT COUNT() FROM Choice_List__c]);
            Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
        }
    }

    @IsTest
    static void refusesMalformedOversizedAndUngrantedRequestsBeforeDml() {
        User integration;
        User ordinary;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('importbad');
            ordinary = createUser('importno');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            for (
                String body : new List<String>{
                    '[]',
                    '{}',
                    '{"schemaVersion":1,"extra":true}',
                    '{"schemaVersion":1,"schemaVersion":1}',
                    '{"schemaVersion":1,"definition":{},"mappingBundle":{},"extra":true}',
                    JSON.serialize(sample())
                        .replace(
                            '"definition":',
                            '"unknown":true,"definition":'
                        )
                }
            ) {
                RestResponse response = invoke(
                    'POST',
                    'application/json',
                    body
                );
                Assert.areEqual(400, response.statusCode);
                Assert.areEqual(
                    '{"schemaVersion":1,"error":"DEFINITION_IMPORT_REFUSED"}',
                    response.responseBody.toString()
                );
            }
            Assert.areEqual(
                405,
                invoke('GET', 'application/json', '{}').statusCode
            );
            Assert.areEqual(415, invoke('POST', 'text/plain', '{}').statusCode);
            DefinitionImportResource.requestByteLimit = 10;
            Assert.areEqual(
                413,
                invoke('POST', 'application/json', JSON.serialize(sample()))
                    .statusCode
            );
            Assert.areEqual(0, [SELECT COUNT() FROM Form__c]);
        }
        System.runAs(ordinary) {
            Integer dmlBefore = Limits.getDmlStatements();
            RestResponse forbidden = invoke('POST', null, null);
            Assert.areEqual(403, forbidden.statusCode);
            Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        }
    }

    private static DefinitionImportService.ImportEnvelope sample() {
        DefinitionImportService.FormInput form = new DefinitionImportService.FormInput();
        form.key = 'portable_import';
        form.title = 'Portable import';
        form.version = 2;

        DefinitionImportService.QuestionInput count = question(
            'student_count',
            'integer',
            1
        );
        count.label = 'Student count';
        count.required = true;
        count.minimum = 0;
        count.maximum = 40;
        count.authorNotes = 'AUTHOR_ONLY_IMPORT_SENTINEL';
        DefinitionImportService.QuestionInput repeatNode = question(
            'students',
            'repeat',
            2
        );
        repeatNode.repeatMode = 'from_answer';
        repeatNode.repeatSourceQuestion = 'student_count';
        repeatNode.repeatMax = 40;
        DefinitionImportService.QuestionInput answer = question(
            'present',
            'select_one',
            1
        );
        answer.parent = 'students';
        answer.choiceList = 'yes_no';
        answer.label = 'Present?';

        DefinitionImportService.ChoiceInput yes = new DefinitionImportService.ChoiceInput();
        yes.value = 'yes';
        yes.label = 'Yes';
        yes.order = 1;
        DefinitionImportService.ChoiceInput no = new DefinitionImportService.ChoiceInput();
        no.value = 'no';
        no.label = 'No';
        no.order = 2;
        DefinitionImportService.ChoiceListInput listDefinition = new DefinitionImportService.ChoiceListInput();
        listDefinition.name = 'yes_no';
        listDefinition.choices = new List<DefinitionImportService.ChoiceInput>{
            yes,
            no
        };

        DefinitionImportService.SkipRuleInput rule = new DefinitionImportService.SkipRuleInput();
        rule.question = 'present';
        rule.sourceQuestion = 'student_count';
        rule.operator = 'greater_than';
        rule.value = '0';
        rule.join = 'all';
        rule.action = 'show';

        DefinitionImportService.FieldInput mainField = new DefinitionImportService.FieldInput();
        mainField.targetField = 'Name';
        mainField.transform = 'text_truncate';
        mainField.sourceKind = 'question';
        mainField.question = 'student_count';
        DefinitionImportService.MappingInput main = mapping(
            'main_mapping',
            'Account',
            'main',
            1
        );
        main.fields.add(mainField);

        DefinitionImportService.FieldInput repeatField = new DefinitionImportService.FieldInput();
        repeatField.targetField = 'Present__c';
        repeatField.transform = 'picklist_match';
        repeatField.sourceKind = 'question';
        repeatField.question = 'present';
        DefinitionImportService.MappingInput repeatMapping = mapping(
            'repeat_mapping',
            'Student__c',
            'repeat',
            2
        );
        repeatMapping.repeatQuestion = 'students';
        repeatMapping.parentMapping = 'main_mapping';
        repeatMapping.parentLookupField = 'Account__c';
        repeatMapping.fields.add(repeatField);

        DefinitionImportService.DefinitionInput definition = new DefinitionImportService.DefinitionInput();
        definition.schemaVersion = 1;
        definition.form = form;
        definition.questions = new List<DefinitionImportService.QuestionInput>{
            answer,
            repeatNode,
            count
        };
        definition.choiceLists = new List<DefinitionImportService.ChoiceListInput>{
            listDefinition
        };
        definition.skipRules = new List<DefinitionImportService.SkipRuleInput>{
            rule
        };
        DefinitionImportService.MappingBundleInput mappings = new DefinitionImportService.MappingBundleInput();
        mappings.schemaVersion = 1;
        mappings.mappings = new List<DefinitionImportService.MappingInput>{
            repeatMapping,
            main
        };
        DefinitionImportService.ImportEnvelope input = new DefinitionImportService.ImportEnvelope();
        input.schemaVersion = 1;
        input.definition = definition;
        input.mappingBundle = mappings;
        return input;
    }

    private static DefinitionImportService.QuestionInput question(
        String name,
        String typeName,
        Integer orderValue
    ) {
        DefinitionImportService.QuestionInput result = new DefinitionImportService.QuestionInput();
        result.name = name;
        result.type = typeName;
        result.order = orderValue;
        return result;
    }

    private static DefinitionImportService.MappingInput mapping(
        String key,
        String target,
        String kind,
        Integer orderValue
    ) {
        DefinitionImportService.MappingInput result = new DefinitionImportService.MappingInput();
        result.key = key;
        result.order = orderValue;
        result.kind = kind;
        result.targetObject = target;
        result.fields = new List<DefinitionImportService.FieldInput>();
        return result;
    }

    private static RestResponse invoke(
        String method,
        String contentType,
        String body
    ) {
        RestRequest request = new RestRequest();
        request.requestUri = '/services/apexrest/v1/definitions/import';
        request.httpMethod = method;
        if (contentType != null)
            request.addHeader('Content-Type', contentType);
        if (body != null)
            request.requestBody = Blob.valueOf(body);
        RestContext.request = request;
        RestContext.response = new RestResponse();
        DefinitionImportResource.importDefinition();
        return RestContext.response;
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
            LastName = 'Definition import ' + marker,
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
