/**
 * Responsibility: prove cleanup deletes exactly two private, caller-owned files
 * atomically and that the REST boundary refuses linked, published, foreign and
 * malformed evidence without disclosure.
 */
@IsTest
private class PublicationArtifactCleanupResourceTest {
    private static final String DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    private static final String REFUSED = '{"schemaVersion":1,"error":"PUBLICATION_ARTIFACT_CLEANUP_REFUSED"}';

    @IsTest
    static void deletesExactPrivateArtifacts() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('cleanok');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form_Version__c version = createDraft('Cleanup success');
            Map<String, Id> files = createFiles();
            RestResponse response = invoke(
                'POST',
                'application/json',
                validBody(version.Id, files.get('xml'), files.get('xlsx'))
            );
            Assert.areEqual(200, response.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"deleted":true}',
                response.responseBody.toString()
            );
            Assert.areEqual(
                0,
                [
                    SELECT COUNT()
                    FROM ContentVersion
                    WHERE
                        Id IN :new Set<Id>{
                            files.get('xml'),
                            files.get('xlsx')
                        }
                ]
            );
            Form_Version__c unchanged = [
                SELECT Status__c, Publication_Digest__c
                FROM Form_Version__c
                WHERE Id = :version.Id
            ];
            Assert.areEqual('Draft', unchanged.Status__c);
            Assert.isNull(unchanged.Publication_Digest__c);
        }
    }

    @IsTest
    static void refusesAnyLinkOrChangedIdentityWithoutDeletingEitherFile() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('cleanref');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form_Version__c version = createDraft('Cleanup refusal');
            Map<String, Id> files = createFiles();
            ContentVersion xml = [
                SELECT ContentDocumentId
                FROM ContentVersion
                WHERE Id = :files.get('xml')
            ];
            insert new ContentDocumentLink(
                ContentDocumentId = xml.ContentDocumentId,
                LinkedEntityId = version.Id,
                ShareType = 'V',
                Visibility = 'AllUsers'
            );
            RestResponse linked = invoke(
                'POST',
                'application/json',
                validBody(version.Id, files.get('xml'), files.get('xlsx'))
            );
            Assert.areEqual(400, linked.statusCode);
            Assert.areEqual(REFUSED, linked.responseBody.toString());
            Assert.areEqual(
                2,
                [
                    SELECT COUNT()
                    FROM ContentVersion
                    WHERE
                        Id IN :new Set<Id>{
                            files.get('xml'),
                            files.get('xlsx')
                        }
                ]
            );

            delete [
                SELECT Id
                FROM ContentDocumentLink
                WHERE
                    ContentDocumentId = :xml.ContentDocumentId
                    AND LinkedEntityId = :version.Id
            ];
            RestResponse changedDigest = invoke(
                'POST',
                'application/json',
                validBody(version.Id, files.get('xml'), files.get('xlsx'))
                    .replace(DIGEST, 'f'.repeat(64))
            );
            Assert.areEqual(400, changedDigest.statusCode);
            Assert.areEqual(REFUSED, changedDigest.responseBody.toString());
            Assert.areEqual(
                2,
                [
                    SELECT COUNT()
                    FROM ContentVersion
                    WHERE
                        Id IN :new Set<Id>{
                            files.get('xml'),
                            files.get('xlsx')
                        }
                ]
            );
        }
    }

    @IsTest
    static void refusesPublishedOrForeignArtifacts() {
        User integration;
        User foreignOwner;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('cleanpub');
            foreignOwner = createUser('cleanown');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }

        Map<String, Id> foreignFiles;
        System.runAs(foreignOwner) {
            foreignFiles = createFiles();
        }
        System.runAs(integration) {
            Form_Version__c foreignVersion = createDraft(
                'Foreign cleanup refusal'
            );
            RestResponse foreign = invoke(
                'POST',
                'application/json',
                validBody(
                    foreignVersion.Id,
                    foreignFiles.get('xml'),
                    foreignFiles.get('xlsx')
                )
            );
            Assert.areEqual(400, foreign.statusCode);
            Assert.areEqual(REFUSED, foreign.responseBody.toString());
        }
        System.runAs(foreignOwner) {
            Assert.areEqual(
                2,
                [
                    SELECT COUNT()
                    FROM ContentVersion
                    WHERE
                        Id IN :new Set<Id>{
                            foreignFiles.get('xml'),
                            foreignFiles.get('xlsx')
                        }
                ]
            );
        }

        System.runAs(integration) {
            Form_Version__c publishedVersion = createDraft(
                'Published cleanup refusal'
            );
            Map<String, Id> publishedFiles = createFiles();
            PublicationLifecycle.commitPublication(
                publishedVersion.Id,
                DIGEST,
                publishedFiles.get('xml'),
                publishedFiles.get('xlsx'),
                null
            );
            RestResponse published = invoke(
                'POST',
                'application/json',
                validBody(
                    publishedVersion.Id,
                    publishedFiles.get('xml'),
                    publishedFiles.get('xlsx')
                )
            );
            Assert.areEqual(400, published.statusCode);
            Assert.areEqual(REFUSED, published.responseBody.toString());
            Assert.areEqual(
                2,
                [
                    SELECT COUNT()
                    FROM ContentVersion
                    WHERE
                        Id IN :new Set<Id>{
                            publishedFiles.get('xml'),
                            publishedFiles.get('xlsx')
                        }
                ]
            );
        }
    }

    @IsTest
    static void refusesMissingOwnerLinkOrPublicDelivery() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('cleanext');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form_Version__c version = createDraft('External cleanup refusal');
            Map<String, Id> files = createFiles();
            ContentVersion xml = [
                SELECT ContentDocumentId
                FROM ContentVersion
                WHERE Id = :files.get('xml')
            ];
            delete [
                SELECT Id
                FROM ContentDocumentLink
                WHERE
                    ContentDocumentId = :xml.ContentDocumentId
                    AND LinkedEntityId = :integration.Id
            ];
            RestResponse missingLink = invoke(
                'POST',
                'application/json',
                validBody(version.Id, files.get('xml'), files.get('xlsx'))
            );
            Assert.areEqual(400, missingLink.statusCode);
            Assert.areEqual(REFUSED, missingLink.responseBody.toString());
            Assert.areEqual(2, countVersions(files));

            Map<String, Id> deliveredFiles = createFiles();
            insert new ContentDistribution(
                Name = 'Public cleanup refusal',
                ContentVersionId = deliveredFiles.get('xml'),
                PreferencesAllowViewInBrowser = true,
                PreferencesLinkLatestVersion = false
            );
            RestResponse delivered = invoke(
                'POST',
                'application/json',
                validBody(
                    version.Id,
                    deliveredFiles.get('xml'),
                    deliveredFiles.get('xlsx')
                )
            );
            Assert.areEqual(400, delivered.statusCode);
            Assert.areEqual(REFUSED, delivered.responseBody.toString());
            Assert.areEqual(2, countVersions(deliveredFiles));
        }
    }

    @IsTest
    static void strictlyDecodesAndChecksPermissionBeforeTheBody() {
        User ordinary;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            ordinary = createUser('cleandny');
        }
        System.runAs(ordinary) {
            RestResponse forbidden = invoke('POST', null, null);
            Assert.areEqual(403, forbidden.statusCode);
            Assert.areEqual(
                '{"schemaVersion":1,"error":"PUBLICATION_ARTIFACT_CLEANUP_FORBIDDEN"}',
                forbidden.responseBody.toString()
            );
        }

        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('cleanbad');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            String idValue = String.valueOf(UserInfo.getUserId());
            for (
                String body : new List<String>{
                    '[]',
                    '{}',
                    '{"schemaVersion":1,"formVersionId":"' +
                    idValue +
                    '","publicationDigest":"' +
                    DIGEST +
                    '","xformVersionId":"' +
                    idValue +
                    '","xlsformVersionId":"' +
                    idValue +
                    '","force":true}',
                    '{"schemaVersion":2}'
                }
            ) {
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
            Assert.areEqual(
                405,
                invoke('GET', 'application/json', '{}').statusCode
            );
            Assert.areEqual(415, invoke('POST', 'text/plain', '{}').statusCode);
            Assert.areEqual(
                413,
                invoke('POST', 'application/json', 'x'.repeat(4097)).statusCode
            );
        }
    }

    private static RestResponse invoke(
        String method,
        String mediaType,
        String body
    ) {
        RestRequest request = new RestRequest();
        request.requestUri = '/services/apexrest/v1/publications/artifacts/cleanup';
        request.httpMethod = method;
        if (mediaType != null)
            request.addHeader('Content-Type', mediaType);
        if (body != null)
            request.requestBody = Blob.valueOf(body);
        RestContext.request = request;
        RestContext.response = new RestResponse();
        PublicationArtifactCleanupResource.cleanup();
        return RestContext.response;
    }

    private static String validBody(
        Id versionId,
        Id xformVersionId,
        Id xlsformVersionId
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
        output.writeEndObject();
        return output.getAsString();
    }

    private static Form_Version__c createDraft(String name) {
        Form__c form = new Form__c(Name = name);
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        return version;
    }

    private static Map<String, Id> createFiles() {
        return new Map<String, Id>{
            'xml' => createFile('xform', 'xml', '<data/>'),
            'xlsx' => createFile('xlsform', 'xlsx', 'workbook')
        };
    }

    private static Integer countVersions(Map<String, Id> files) {
        return [
            SELECT COUNT()
            FROM ContentVersion
            WHERE Id IN :new Set<Id>{ files.get('xml'), files.get('xlsx') }
        ];
    }

    private static Id createFile(String suffix, String extension, String body) {
        ContentVersion version = new ContentVersion(
            Title = 'kusanya-' + DIGEST + '-' + suffix,
            PathOnClient = DIGEST + '.' + extension,
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
            LastName = 'Artifact Cleanup ' + marker,
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
