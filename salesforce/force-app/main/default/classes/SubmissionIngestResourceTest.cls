/**
 * Responsibility: prove raw receipt is permission-gated, byte-attested,
 * idempotent and private, and never confuses receipt with completed mapping.
 */
@IsTest
private class SubmissionIngestResourceTest {
    @IsTest
    static void receivesExactBytesAndReplaysWithoutDuplicateRecords() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('ingestok');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        Blob xml = Blob.valueOf(
            '<data><meta><instanceID>uuid:123e4567-e89b-12d3-a456-426614174000</instanceID></meta></data>'
        );
        System.runAs(integration) {
            Form_Version__c version = publishedVersion();
            String relayId = '20000000-0000-4000-8000-000000000001';
            String instanceId = 'uuid:123e4567-e89b-12d3-a456-426614174000';
            String body = requestBody(
                relayId,
                version.Id,
                instanceId,
                xml,
                null
            );
            RestResponse first = invoke('POST', 'application/json', body);
            Assert.areEqual(200, first.statusCode);
            assertOutcome(first, relayId, 'received', 'RECEIVED');
            Submission__c stored = [
                SELECT Id, Status__c, XML_Hash__c, Raw_XML_Version__c
                FROM Submission__c
                WHERE Instance_Id__c = :instanceId
            ];
            Assert.areEqual('Received', stored.Status__c);
            Assert.isNotNull(stored.Raw_XML_Version__c);
            ContentVersion raw = [
                SELECT VersionData, ContentDocumentId
                FROM ContentVersion
                WHERE Id = :stored.Raw_XML_Version__c
            ];
            Assert.areEqual(xml, raw.VersionData);
            Assert.areEqual(
                1,
                [
                    SELECT COUNT()
                    FROM ContentDocumentLink
                    WHERE
                        LinkedEntityId = :stored.Id
                        AND ContentDocumentId = :raw.ContentDocumentId
                ]
            );

            RestResponse replay = invoke('POST', 'application/json', body);
            Assert.areEqual(200, replay.statusCode);
            assertOutcome(replay, relayId, 'received', 'ALREADY_RECEIVED');
            Assert.areEqual(1, [SELECT COUNT() FROM Submission__c]);
            Assert.areEqual(3, [SELECT COUNT() FROM ContentVersion]);

            stored.Status__c = 'Mapped';
            update stored;
            assertOutcome(
                invoke('POST', 'application/json', body),
                relayId,
                'mapped',
                'ALREADY_MAPPED'
            );
            Assert.areEqual(1, [SELECT COUNT() FROM Submission__c]);
        }
    }

    @IsTest
    static void refusesConflictsMalformedBodiesAndUngrantedCallers() {
        User integration;
        User ordinary;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('ingestbad');
            ordinary = createUser('ingestno');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        Blob xml = Blob.valueOf(
            '<data><meta><instanceID>uuid:123e4567-e89b-12d3-a456-426614174001</instanceID></meta></data>'
        );
        String relayId = '20000000-0000-4000-8000-000000000002';
        String instanceId = 'uuid:123e4567-e89b-12d3-a456-426614174001';
        System.runAs(integration) {
            Form_Version__c version = publishedVersion();
            String valid = requestBody(
                relayId,
                version.Id,
                instanceId,
                xml,
                null
            );
            Assert.areEqual(
                200,
                invoke('POST', 'application/json', valid).statusCode
            );
            Blob changed = Blob.valueOf('<changed/>');
            assertOutcome(
                invoke(
                    'POST',
                    'application/json',
                    requestBody(relayId, version.Id, instanceId, changed, null)
                ),
                relayId,
                'dead',
                'INSTANCE_CONFLICT'
            );
            for (
                String invalid : new List<String>{
                    '{}',
                    '[]',
                    valid.replace('"schemaVersion":1', '"schemaVersion":2'),
                    valid.replace(
                        '"schemaVersion":1',
                        '"schemaVersion":1,"schemaVersion":1'
                    ),
                    valid.replace(
                        EncodingUtil.base64Encode(xml),
                        EncodingUtil.base64Encode(Blob.valueOf('<tampered/>'))
                    ),
                    valid.replace('"channel":"phone"', '"channel":"email"')
                }
            ) {
                RestResponse refused = invoke(
                    'POST',
                    'application/json',
                    invalid
                );
                Assert.areEqual(400, refused.statusCode);
                Assert.isFalse(refused.responseBody.toString().contains('<'));
            }
            Assert.areEqual(
                405,
                invoke('GET', 'application/json', valid).statusCode
            );
            Assert.areEqual(
                415,
                invoke('POST', 'text/plain', valid).statusCode
            );
            SubmissionIngestResource.requestByteLimit = 10;
            Assert.areEqual(
                413,
                invoke('POST', 'application/json', valid).statusCode
            );
        }
        System.runAs(ordinary) {
            Integer dmlBefore = Limits.getDmlStatements();
            RestResponse forbidden = invoke('POST', null, null);
            Assert.areEqual(403, forbidden.statusCode);
            Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        }
    }

    private static Form_Version__c publishedVersion() {
        Form__c form = new Form__c(Name = 'Submission receipt');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        ContentVersion xml = createFile('receipt.xml', '<data/>');
        ContentVersion xlsx = createFile('receipt.xlsx', 'workbook');
        PublicationLifecycle.commitPublication(
            version.Id,
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            xml.Id,
            xlsx.Id,
            null
        );
        version.Status__c = 'Published';
        return version;
    }

    private static ContentVersion createFile(String path, String body) {
        ContentVersion version = new ContentVersion(
            Title = path.substring(0, path.lastIndexOf('.')),
            PathOnClient = path,
            VersionData = Blob.valueOf(body)
        );
        insert version;
        return version;
    }

    private static String requestBody(
        String relayId,
        Id versionId,
        String instanceId,
        Blob xml,
        String channel
    ) {
        String digest = EncodingUtil.convertToHex(
            Crypto.generateDigest('SHA-256', xml)
        );
        return JSON.serialize(
            new Map<String, Object>{
                'schemaVersion' => 1,
                'submissions' => new List<Object>{
                    new Map<String, Object>{
                        'relayId' => relayId,
                        'formVersionId' => String.valueOf(versionId),
                        'instanceId' => instanceId,
                        'channel' => channel == null ? 'phone' : channel,
                        'xmlSha256' => digest,
                        'rawXmlBase64' => EncodingUtil.base64Encode(xml)
                    }
                }
            }
        );
    }

    private static RestResponse invoke(
        String method,
        String contentType,
        String body
    ) {
        RestRequest request = new RestRequest();
        request.httpMethod = method;
        request.requestUri = '/services/apexrest/v1/submissions/ingest';
        if (contentType != null)
            request.addHeader('Content-Type', contentType);
        if (body != null)
            request.requestBody = Blob.valueOf(body);
        RestContext.request = request;
        RestContext.response = new RestResponse();
        SubmissionIngestResource.ingest();
        return RestContext.response;
    }

    private static void assertOutcome(
        RestResponse response,
        String relayId,
        String status,
        String code
    ) {
        Map<String, Object> envelope = (Map<String, Object>) JSON.deserializeUntyped(
            response.responseBody.toString()
        );
        List<Object> outcomes = (List<Object>) envelope.get('outcomes');
        Assert.areEqual(1, outcomes.size());
        Map<String, Object> outcome = (Map<String, Object>) outcomes[0];
        Assert.areEqual(relayId, outcome.get('relayId'));
        Assert.areEqual(status, outcome.get('status'));
        Assert.areEqual(code, outcome.get('code'));
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
            LastName = 'Submission receipt ' + marker,
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
