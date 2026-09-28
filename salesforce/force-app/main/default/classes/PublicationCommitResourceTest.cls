/**
 * Responsibility: prove the publication REST boundary is integration-only,
 * strictly decoded, bounded, deterministic and delegates to the existing atomic
 * lifecycle without weakening its exact-retry or non-disclosure contracts.
 */
@IsTest
private class PublicationCommitResourceTest {
    private static final String DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    private static final String REFUSED = '{"schemaVersion":1,"error":"PUBLICATION_COMMIT_REFUSED"}';

    @IsTest
    static void commitsAndRetriesThroughTheIntegrationBoundary() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('apiok');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form__c form = new Form__c(Name = 'REST publication');
            insert form;
            Form_Version__c version = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 1
            );
            insert version;
            Map<String, Id> files = createFiles('rest');
            String body = validBody(
                version.Id,
                files.get('xml'),
                files.get('xlsx'),
                'DYNAMIC_REPEAT_CLIENT_SPECIFIC'
            );

            RestResponse committed = invoke('POST', 'application/json', body);
            Assert.areEqual(200, committed.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"alreadyCommitted":false,"publicationDigest":"' +
                    DIGEST +
                    '"}',
                committed.responseBody.toString()
            );
            Form_Version__c saved = [
                SELECT
                    Status__c,
                    XForm_Version__c,
                    XLSForm_Version__c,
                    Publication_Digest__c,
                    Compile_Warnings__c
                FROM Form_Version__c
                WHERE Id = :version.Id
            ];
            Assert.areEqual('Published', saved.Status__c);
            Assert.areEqual(
                String.valueOf(files.get('xml')),
                saved.XForm_Version__c
            );
            Assert.areEqual(
                String.valueOf(files.get('xlsx')),
                saved.XLSForm_Version__c
            );
            Assert.areEqual(DIGEST, saved.Publication_Digest__c);
            Assert.areEqual(
                'DYNAMIC_REPEAT_CLIENT_SPECIFIC',
                saved.Compile_Warnings__c
            );

            Integer dmlBefore = Limits.getDmlStatements();
            RestResponse retried = invoke(
                'POST',
                'application/json; charset=UTF-8',
                body
            );
            Assert.areEqual(200, retried.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"alreadyCommitted":true,"publicationDigest":"' +
                    DIGEST +
                    '"}',
                retried.responseBody.toString()
            );
            Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        }
    }

    @IsTest
    static void refusesMalformedAndOversizedRequestsWithoutDisclosure() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('apibad');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            String idValue = String.valueOf(UserInfo.getUserId());
            String fields =
                '"formVersionId":"' +
                idValue +
                '","publicationDigest":"' +
                DIGEST +
                '","xformVersionId":"' +
                idValue +
                '","xlsformVersionId":"' +
                idValue +
                '","compileWarnings":null';
            List<String> malformed = new List<String>{
                '[]',
                '{}',
                '{"schemaVersion":1,' +
                fields +
                ',"extra":true}',
                '{"schemaVersion":1,"schemaVersion":1,' +
                fields +
                '}',
                '{"schemaVersion":2,' +
                fields +
                '}',
                '{"schemaVersion":"1",' +
                fields +
                '}',
                '{"schemaVersion":1,' +
                fields.replace('null', '3') +
                '}',
                '{"schemaVersion":1,' +
                fields.replace(
                    '"formVersionId":"' + idValue + '"',
                    '"formVersionId":{}'
                ) +
                '}',
                '{"schemaVersion":1,' +
                fields +
                '} trailing'
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

            String chunk = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
            List<String> chunks = new List<String>();
            for (Integer index = 0; index < 2000; index++) {
                chunks.add(chunk);
            }
            String atLimit = String.join(chunks, '');
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
                '{"schemaVersion":1,"error":"PUBLICATION_COMMIT_TOO_LARGE"}',
                tooLarge.responseBody.toString()
            );
        }
    }

    @IsTest
    static void refusesAnUngrantedPrincipalBeforeReadingTheBody() {
        User ordinary;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            ordinary = createUser('apideny');
        }
        System.runAs(ordinary) {
            Integer dmlBefore = Limits.getDmlStatements();
            RestResponse response = invoke('POST', null, null);
            Assert.areEqual(403, response.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"error":"PUBLICATION_COMMIT_FORBIDDEN"}',
                response.responseBody.toString()
            );
            Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        }
    }

    private static RestResponse invoke(
        String method,
        String contentType,
        String body
    ) {
        RestRequest request = new RestRequest();
        request.requestUri = '/services/apexrest/v1/publications/commit';
        request.httpMethod = method;
        if (contentType != null) {
            request.addHeader('Content-Type', contentType);
        }
        if (body != null) {
            request.requestBody = Blob.valueOf(body);
        }
        RestContext.request = request;
        RestContext.response = new RestResponse();
        PublicationCommitResource.publish();
        return RestContext.response;
    }

    private static String validBody(
        Id versionId,
        Id xformVersionId,
        Id xlsformVersionId,
        String warnings
    ) {
        JSONGenerator output = JSON.createGenerator(false);
        output.writeStartObject();
        output.writeNumberField('schemaVersion', 1);
        output.writeStringField('formVersionId', String.valueOf(versionId));
        output.writeStringField('publicationDigest', DIGEST);
        output.writeStringField(
            'xformVersionId',
            String.valueOf(xformVersionId)
        );
        output.writeStringField(
            'xlsformVersionId',
            String.valueOf(xlsformVersionId)
        );
        if (warnings == null) {
            output.writeNullField('compileWarnings');
        } else {
            output.writeStringField('compileWarnings', warnings);
        }
        output.writeEndObject();
        return output.getAsString();
    }

    private static Map<String, Id> createFiles(String marker) {
        Id xml = createFile(marker + '.xml', '<data/>');
        Id xlsx = createFile(marker + '.xlsx', 'synthetic workbook');
        return new Map<String, Id>{ 'xml' => xml, 'xlsx' => xlsx };
    }

    private static Id createFile(String path, String body) {
        ContentVersion version = new ContentVersion(
            Title = path.substring(0, path.lastIndexOf('.')),
            PathOnClient = path,
            VersionData = Blob.valueOf(body)
        );
        insert version;
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
            LastName = 'Publication API ' + marker,
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
