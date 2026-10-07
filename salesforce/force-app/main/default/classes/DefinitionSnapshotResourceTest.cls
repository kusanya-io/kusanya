/**
 * Responsibility: prove the definition snapshot REST boundary is integration-only,
 * strictly decoded, bounded, deterministic and delegates to the existing user-mode
 * reader without exposing Salesforce relationship identifiers.
 */
@IsTest
private class DefinitionSnapshotResourceTest {
    private static final String REFUSED = '{"schemaVersion":1,"error":"DEFINITION_SNAPSHOT_REFUSED"}';

    @IsTest
    static void returnsDeterministicPortableCrossOwnerSnapshot() {
        Id versionId = createDefinition();
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('snapok');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }

        System.runAs(integration) {
            String requestBody = validBody(versionId);
            Integer dmlBefore = Limits.getDmlStatements();
            Integer queriesBefore = Limits.getQueries();
            RestResponse first = invoke(
                'POST',
                'application/json',
                requestBody
            );
            RestResponse second = invoke(
                'POST',
                'application/json; charset=UTF-8',
                requestBody
            );
            Assert.areEqual(200, first.statusCode);
            Assert.areEqual(200, second.statusCode);
            Assert.areEqual(
                first.responseBody.toString(),
                second.responseBody.toString()
            );
            Assert.areEqual(dmlBefore, Limits.getDmlStatements());
            Assert.isTrue(Limits.getQueries() - queriesBefore <= 14);

            Map<String, Object> snapshot = (Map<String, Object>) JSON.deserializeUntyped(
                first.responseBody.toString()
            );
            Assert.areEqual(1, snapshot.get('schemaVersion'));
            Map<String, Object> definition = (Map<String, Object>) snapshot.get(
                'definition'
            );
            Map<String, Object> form = (Map<String, Object>) definition.get(
                'form'
            );
            Assert.areEqual('REST snapshot', form.get('title'));
            Assert.areEqual(
                1,
                ((List<Object>) definition.get('questions')).size()
            );
            Assert.areEqual(
                1,
                ((List<Object>) ((Map<String, Object>) snapshot.get(
                            'mappingBundle'
                        ))
                        .get('mappings'))
                    .size()
            );

            String serialized = first.responseBody.toString();
            Assert.isFalse(serialized.contains(String.valueOf(versionId)));
            for (Question__c question : [SELECT Id FROM Question__c]) {
                Assert.isFalse(
                    serialized.contains(String.valueOf(question.Id))
                );
            }
            for (Mapping__c mapping : [SELECT Id FROM Mapping__c]) {
                Assert.isFalse(serialized.contains(String.valueOf(mapping.Id)));
            }
        }
    }

    @IsTest
    static void refusesMalformedOversizedAndWrongIdentityRequests() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('snapbad');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            String idValue = String.valueOf(UserInfo.getUserId());
            List<String> malformed = new List<String>{
                '[]',
                '{}',
                '{"schemaVersion":1,"formVersionId":"' +
                idValue +
                '","extra":true}',
                '{"schemaVersion":1,"schemaVersion":1,"formVersionId":"' +
                idValue +
                '"}',
                '{"schemaVersion":2,"formVersionId":"' +
                idValue +
                '"}',
                '{"schemaVersion":"1","formVersionId":"' +
                idValue +
                '"}',
                '{"schemaVersion":1,"formVersionId":{}}',
                '{"schemaVersion":1,"formVersionId":"' +
                idValue +
                '"} trailing'
            };
            for (String body : malformed) {
                RestResponse response = invoke(
                    'POST',
                    'application/json',
                    body
                );
                Assert.areEqual(400, response.statusCode);
                Assert.areEqual(REFUSED, response.responseBody.toString());
                Assert.isFalse(
                    response.responseBody.toString().contains(idValue)
                );
            }

            RestResponse wrongIdentity = invoke(
                'POST',
                'application/json',
                validBody(UserInfo.getUserId())
            );
            Assert.areEqual(400, wrongIdentity.statusCode);
            Assert.areEqual(REFUSED, wrongIdentity.responseBody.toString());
            Assert.isFalse(
                wrongIdentity.responseBody.toString().contains(idValue)
            );

            RestResponse empty = invoke('POST', 'application/json', null);
            Assert.areEqual(400, empty.statusCode);
            Assert.areEqual(REFUSED, empty.responseBody.toString());
            Assert.areEqual(
                405,
                invoke('GET', 'application/json', '{}').statusCode
            );
            Assert.areEqual(415, invoke('POST', 'text/plain', '{}').statusCode);
            Assert.areEqual(
                415,
                invoke('POST', 'application/json; charset=UTF-16', '{}')
                    .statusCode
            );
            Assert.areEqual(415, invoke('POST', null, '{}').statusCode);

            String chunk = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
            List<String> chunks = new List<String>();
            for (Integer index = 0; index < 32; index++) {
                chunks.add(chunk);
            }
            String atLimit = String.join(chunks, '');
            Assert.areEqual(2048, Blob.valueOf(atLimit).size());
            RestResponse bounded = invoke('POST', 'application/json', atLimit);
            Assert.areEqual(400, bounded.statusCode);
            Assert.areEqual(REFUSED, bounded.responseBody.toString());
            RestResponse tooLarge = invoke(
                'POST',
                'application/json',
                atLimit + 'x'
            );
            Assert.areEqual(413, tooLarge.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"error":"DEFINITION_SNAPSHOT_TOO_LARGE"}',
                tooLarge.responseBody.toString()
            );
        }
    }

    @IsTest
    static void refusesUngrantedPrincipalsBeforeReadingTheBody() {
        User ordinary;
        User supervisor;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            ordinary = createUser('snapnone');
            supervisor = createUser('snapsup');
            assignPermission(supervisor.Id, 'Kusanya_Supervisor');
        }
        for (User principal : new List<User>{ ordinary, supervisor }) {
            System.runAs(principal) {
                Integer queriesBefore = Limits.getQueries();
                Integer dmlBefore = Limits.getDmlStatements();
                RestResponse response = invoke('POST', null, null);
                Assert.areEqual(403, response.statusCode);
                Assert.areEqual(
                    '{"schemaVersion":1,"error":"DEFINITION_SNAPSHOT_FORBIDDEN"}',
                    response.responseBody.toString()
                );
                Assert.areEqual(queriesBefore, Limits.getQueries());
                Assert.areEqual(dmlBefore, Limits.getDmlStatements());
            }
        }
    }

    @IsTest
    static void refusesOversizedResponsesWithoutDisclosure() {
        Id versionId = createDefinition();
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('snapout');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            DefinitionSnapshotResource.responseByteLimit = 1;
            RestResponse response = invoke(
                'POST',
                'application/json',
                validBody(versionId)
            );
            Assert.areEqual(500, response.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"error":"DEFINITION_SNAPSHOT_FAILED"}',
                response.responseBody.toString()
            );
            Assert.isFalse(
                response.responseBody.toString()
                    .contains(String.valueOf(versionId))
            );
        }
    }

    private static RestResponse invoke(
        String method,
        String contentType,
        String body
    ) {
        RestRequest request = new RestRequest();
        request.requestUri = '/services/apexrest/v1/publications/definition';
        request.httpMethod = method;
        if (contentType != null) {
            request.addHeader('Content-Type', contentType);
        }
        if (body != null) {
            request.requestBody = Blob.valueOf(body);
        }
        RestContext.request = request;
        RestContext.response = new RestResponse();
        DefinitionSnapshotResource.readDefinition();
        return RestContext.response;
    }

    private static String validBody(Id versionId) {
        JSONGenerator output = JSON.createGenerator(false);
        output.writeStartObject();
        output.writeNumberField('schemaVersion', 1);
        output.writeStringField('formVersionId', String.valueOf(versionId));
        output.writeEndObject();
        return output.getAsString();
    }

    private static Id createDefinition() {
        Folder__c folder = new Folder__c(Name = 'REST snapshot folder');
        insert folder;
        Form__c form = new Form__c(
            Name = 'REST snapshot',
            Status__c = 'Draft',
            Folder__c = folder.Id
        );
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1,
            Status__c = 'Draft'
        );
        insert version;
        Question__c question = new Question__c(
            Name = 'answer',
            Form_Version__c = version.Id,
            Type__c = 'text',
            Order__c = 1,
            Label__c = 'Answer'
        );
        insert question;
        Mapping__c mapping = new Mapping__c(
            Name = 'REST mapping',
            Form_Version__c = version.Id,
            Target_Object__c = 'Account',
            Kind__c = 'main',
            Order__c = 1
        );
        insert mapping;
        insert new Field_Mapping__c(
            Mapping__c = mapping.Id,
            Target_Field__c = 'Name',
            Transform__c = 'none',
            Source_Kind__c = 'question',
            Question__c = question.Id
        );
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
            LastName = 'Snapshot API ' + marker,
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
