/**
 * Responsibility: prove atomic publication, exact retries, rollback, effective
 * principal access and graph-wide immutability with synthetic Salesforce files.
 * No external endpoint, customer target, OAuth credential or C10 claim is exercised.
 */
@IsTest
private class PublicationLifecycleTest {
    private static final String DIGEST_ONE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    private static final String DIGEST_TWO = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    @IsTest
    static void commitsSupersedesAndRetriesExactly() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('commit');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form__c form = new Form__c(Name = 'Synthetic publication');
            insert form;
            Form_Version__c first = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 1
            );
            insert first;
            Map<String, Id> firstFiles = createFiles('first');

            PublicationLifecycle.Result committed = PublicationLifecycle.commitPublication(
                first.Id,
                DIGEST_ONE,
                firstFiles.get('xml'),
                firstFiles.get('xlsx'),
                'DYNAMIC_REPEAT_CLIENT_SPECIFIC'
            );
            Assert.isFalse(committed.alreadyCommitted);
            Assert.areEqual(first.Id, committed.versionId);
            assertPublished(
                first.Id,
                DIGEST_ONE,
                firstFiles,
                'DYNAMIC_REPEAT_CLIENT_SPECIFIC'
            );

            Integer retryDmlBefore = Limits.getDmlStatements();
            PublicationLifecycle.Result retried = PublicationLifecycle.commitPublication(
                first.Id,
                DIGEST_ONE,
                firstFiles.get('xml'),
                firstFiles.get('xlsx'),
                'DYNAMIC_REPEAT_CLIENT_SPECIFIC'
            );
            Assert.isTrue(retried.alreadyCommitted);
            Assert.areEqual(retryDmlBefore, Limits.getDmlStatements());

            Form_Version__c second = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 2,
                Change_Log__c = 'Second synthetic version'
            );
            insert second;
            Map<String, Id> secondFiles = createFiles('second');
            PublicationLifecycle.Result replacement = PublicationLifecycle.commitPublication(
                second.Id,
                DIGEST_TWO,
                secondFiles.get('xml'),
                secondFiles.get('xlsx'),
                null
            );
            Assert.isFalse(replacement.alreadyCommitted);
            Assert.areEqual(
                'Superseded',
                [SELECT Status__c FROM Form_Version__c WHERE Id = :first.Id]
                .Status__c
            );
            assertPublished(second.Id, DIGEST_TWO, secondFiles, null);
            Form__c savedForm = [
                SELECT Status__c, Current_Version__c
                FROM Form__c
                WHERE Id = :form.Id
            ];
            Assert.areEqual('Published', savedForm.Status__c);
            Assert.areEqual(second.Id, savedForm.Current_Version__c);
            Set<Id> publishedVersionIds = new Set<Id>{ first.Id, second.Id };
            Assert.areEqual(
                4,
                [
                    SELECT COUNT()
                    FROM ContentDocumentLink
                    WHERE LinkedEntityId IN :publishedVersionIds
                ]
            );
        }
    }

    @IsTest
    static void refusesMalformedFilesAndMismatchedRetriesWithoutDisclosure() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('refuse');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form__c form = new Form__c(Name = 'Synthetic refusals');
            insert form;
            Form_Version__c version = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 1
            );
            insert version;
            Map<String, Id> files = createFiles('valid');
            Id wrongExtension = createFile('wrong.txt', 'not an xlsx');

            assertRefused(
                version.Id,
                DIGEST_ONE.toUpperCase(),
                files.get('xml'),
                files.get('xlsx'),
                null
            );
            assertRefused(
                UserInfo.getUserId(),
                DIGEST_ONE,
                files.get('xml'),
                files.get('xlsx'),
                null
            );
            assertRefused(
                version.Id,
                DIGEST_ONE,
                files.get('xml'),
                files.get('xml'),
                null
            );
            assertRefused(
                version.Id,
                DIGEST_ONE,
                UserInfo.getUserId(),
                files.get('xlsx'),
                null
            );
            assertRefused(
                version.Id,
                DIGEST_ONE,
                files.get('xml'),
                wrongExtension,
                null
            );
            Assert.areEqual(
                0,
                [
                    SELECT COUNT()
                    FROM ContentDocumentLink
                    WHERE LinkedEntityId = :version.Id
                ]
            );
            Form__c directPublished = new Form__c(
                Name = 'Invalid direct publication',
                Status__c = 'Published'
            );
            assertFailed(Database.insert(directPublished, false));
            Form_Version__c directMetadata = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 2,
                XForm__c = String.valueOf(files.get('xml'))
            );
            assertFailed(Database.insert(directMetadata, false));

            PublicationLifecycle.commitPublication(
                version.Id,
                DIGEST_ONE,
                files.get('xml'),
                files.get('xlsx'),
                ''
            );
            assertRefused(
                version.Id,
                DIGEST_TWO,
                files.get('xml'),
                files.get('xlsx'),
                null
            );
            assertRefused(
                version.Id,
                DIGEST_ONE,
                files.get('xlsx'),
                files.get('xml'),
                null
            );
            Assert.areEqual(
                DIGEST_ONE,
                [
                    SELECT Publication_Digest__c
                    FROM Form_Version__c
                    WHERE Id = :version.Id
                ]
                .Publication_Digest__c
            );
        }
    }

    @IsTest
    static void rollsBackForAReadOnlyPrincipal() {
        Form__c form = new Form__c(Name = 'Synthetic supervisor target');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        User supervisor;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            supervisor = createUser('readonly');
            assignPermission(supervisor.Id, 'Kusanya_Supervisor');
        }
        System.runAs(supervisor) {
            Map<String, Id> files = createFiles('readonly');
            assertRefused(
                version.Id,
                DIGEST_ONE,
                files.get('xml'),
                files.get('xlsx'),
                null
            );
        }
        Form_Version__c unchanged = [
            SELECT Status__c, Publication_Digest__c
            FROM Form_Version__c
            WHERE Id = :version.Id
        ];
        Assert.areEqual('Draft', unchanged.Status__c);
        Assert.isNull(unchanged.Publication_Digest__c);
        Assert.areEqual(
            0,
            [
                SELECT COUNT()
                FROM ContentDocumentLink
                WHERE LinkedEntityId = :version.Id
            ]
        );
    }

    @IsTest
    static void publishedGraphAndLifecycleFieldsAreImmutable() {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('immutable');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }
        System.runAs(integration) {
            Form__c form = new Form__c(Name = 'Synthetic immutable graph');
            insert form;
            Form_Version__c version = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 1
            );
            insert version;
            Choice_List__c listDefinition = new Choice_List__c(
                Name = 'Synthetic values'
            );
            insert listDefinition;
            Choice__c choice = new Choice__c(
                Choice_List__c = listDefinition.Id,
                Value__c = 'yes',
                Label__c = 'Yes',
                Order__c = 1
            );
            insert choice;
            Question__c source = new Question__c(
                Name = 'source',
                Form_Version__c = version.Id,
                Type__c = 'select_one',
                Choice_List__c = listDefinition.Id,
                Order__c = 1,
                Label__c = 'Source'
            );
            Question__c target = new Question__c(
                Name = 'target',
                Form_Version__c = version.Id,
                Type__c = 'text',
                Order__c = 2,
                Label__c = 'Target'
            );
            insert new List<Question__c>{ source, target };
            Skip_Rule__c rule = new Skip_Rule__c(
                Question__c = target.Id,
                Source_Question__c = source.Id,
                Operator__c = 'is',
                Value__c = 'yes'
            );
            insert rule;
            Mapping__c mapping = new Mapping__c(
                Name = 'Synthetic main',
                Form_Version__c = version.Id,
                Target_Object__c = 'Account',
                Kind__c = 'main',
                Order__c = 1
            );
            insert mapping;
            Field_Mapping__c field = new Field_Mapping__c(
                Mapping__c = mapping.Id,
                Source_Kind__c = 'question',
                Question__c = target.Id,
                Target_Field__c = 'Name',
                Transform__c = 'none'
            );
            insert field;
            Map<String, Id> files = createFiles('immutable');
            PublicationLifecycle.commitPublication(
                version.Id,
                DIGEST_ONE,
                files.get('xml'),
                files.get('xlsx'),
                null
            );

            source.Label__c = 'Changed';
            assertFailed(Database.update(source, false));
            choice.Label__c = 'Changed';
            assertFailed(Database.update(choice, false));
            listDefinition.Description__c = 'Changed';
            assertFailed(Database.update(listDefinition, false));
            rule.Value__c = 'no';
            assertFailed(Database.update(rule, false));
            mapping.Target_Object__c = 'Contact';
            assertFailed(Database.update(mapping, false));
            field.Target_Field__c = 'Description';
            assertFailed(Database.update(field, false));
            assertFailed(Database.delete(choice, false));
            assertFailed(Database.delete(field, false));

            Question__c extra = new Question__c(
                Name = 'extra',
                Form_Version__c = version.Id,
                Type__c = 'text',
                Order__c = 3,
                Label__c = 'Extra'
            );
            assertFailed(Database.insert(extra, false));
            version.Change_Log__c = 'Changed after publication';
            assertFailed(Database.update(version, false));
            assertFailed(Database.delete(version, false));

            Form_Version__c draft = new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 2
            );
            insert draft;
            form.Current_Version__c = draft.Id;
            assertFailed(Database.update(form, false));
            assertFailed(Database.delete(form, false));
        }
    }

    @IsTest
    static void draftDefinitionsRemainEditableAndDeletable() {
        Form__c form = new Form__c(Name = 'Synthetic mutable draft');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        form.Current_Version__c = version.Id;
        update form;
        Question__c question = new Question__c(
            Name = 'draft_question',
            Form_Version__c = version.Id,
            Type__c = 'text',
            Order__c = 1,
            Label__c = 'Before'
        );
        insert question;
        question.Label__c = 'After';
        update question;
        delete question;
        delete version;
        delete form;
    }

    private static void assertPublished(
        Id versionId,
        String digest,
        Map<String, Id> files,
        String warnings
    ) {
        Form_Version__c saved = [
            SELECT
                Status__c,
                XForm__c,
                XLSForm__c,
                Compiled_At__c,
                Compile_Warnings__c,
                Published_By__c,
                Published_At__c,
                Publication_Digest__c
            FROM Form_Version__c
            WHERE Id = :versionId
        ];
        Assert.areEqual('Published', saved.Status__c);
        Assert.areEqual(String.valueOf(files.get('xml')), saved.XForm__c);
        Assert.areEqual(String.valueOf(files.get('xlsx')), saved.XLSForm__c);
        Assert.areEqual(digest, saved.Publication_Digest__c);
        Assert.areEqual(warnings, saved.Compile_Warnings__c);
        Assert.areEqual(UserInfo.getUserId(), saved.Published_By__c);
        Assert.areEqual(saved.Compiled_At__c, saved.Published_At__c);
        Assert.areEqual(
            2,
            [
                SELECT COUNT()
                FROM ContentDocumentLink
                WHERE LinkedEntityId = :versionId
            ]
        );
    }

    private static void assertRefused(
        Id versionId,
        String digest,
        Id xformDocumentId,
        Id xlsformDocumentId,
        String warnings
    ) {
        try {
            PublicationLifecycle.commitPublication(
                versionId,
                digest,
                xformDocumentId,
                xlsformDocumentId,
                warnings
            );
            Assert.fail('Expected a static publication refusal');
        } catch (PublicationLifecycle.RefusedException error) {
            Assert.areEqual('PUBLICATION_COMMIT_REFUSED', error.getMessage());
        }
    }

    private static void assertFailed(Database.SaveResult result) {
        Assert.isFalse(result.isSuccess());
        Assert.isFalse(result.getErrors().isEmpty());
    }

    private static void assertFailed(Database.DeleteResult result) {
        Assert.isFalse(result.isSuccess());
        Assert.isFalse(result.getErrors().isEmpty());
    }

    private static Map<String, Id> createFiles(String marker) {
        return new Map<String, Id>{
            'xml' => createFile(marker + '.xml', '<data/>'),
            'xlsx' => createFile(marker + '.xlsx', 'synthetic workbook')
        };
    }

    private static Id createFile(String path, String body) {
        ContentVersion version = new ContentVersion(
            Title = path.substring(0, path.lastIndexOf('.')),
            PathOnClient = path,
            VersionData = Blob.valueOf(body)
        );
        insert version;
        return [
            SELECT ContentDocumentId
            FROM ContentVersion
            WHERE Id = :version.Id
        ]
        .ContentDocumentId;
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
            LastName = 'Publication ' + marker,
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
