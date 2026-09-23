/**
 * Responsibility: verify bounded portable definition reads and effective access.
 * Uses synthetic records and distinct principals; no customer targets or C10 claim.
 */
@IsTest
private class DefinitionSnapshotReaderTest {
    static void createDefinitionOwnedByAnotherPrincipal() {
        Folder__c folder = new Folder__c(
            Name = 'Synthetic folder',
            Description__c = 'Definition root'
        );
        insert folder;
        Form__c form = new Form__c(
            Name = 'Synthetic snapshot',
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
        Choice_List__c listDefinition = new Choice_List__c(
            Name = 'Human readable choices'
        );
        insert listDefinition;
        insert new List<Choice__c>{
            new Choice__c(
                Choice_List__c = listDefinition.Id,
                Value__c = 'yes',
                Label__c = 'Yes',
                Order__c = 1
            ),
            new Choice__c(
                Choice_List__c = listDefinition.Id,
                Value__c = 'no',
                Label__c = 'No',
                Order__c = 2
            )
        };
        Question__c source = new Question__c(
            Name = 'source',
            Form_Version__c = version.Id,
            Type__c = 'select_one',
            Order__c = 1,
            Label__c = 'Collector label',
            Hint__c = 'Collector hint',
            Author_Notes__c = 'AUTHOR_ONLY_SNAPSHOT_SENTINEL',
            Choice_List__c = listDefinition.Id
        );
        Question__c repeatNode = new Question__c(
            Name = 'rows',
            Form_Version__c = version.Id,
            Type__c = 'repeat',
            Repeat_Mode__c = 'open',
            Order__c = 2,
            Label__c = 'Rows'
        );
        insert new List<Question__c>{ source, repeatNode };
        Question__c answer = new Question__c(
            Name = 'answer',
            Form_Version__c = version.Id,
            Parent__c = repeatNode.Id,
            Type__c = 'text',
            Order__c = 1,
            Label__c = 'Answer',
            Required__c = true
        );
        insert answer;
        insert new Skip_Rule__c(
            Question__c = answer.Id,
            Source_Question__c = source.Id,
            Operator__c = 'is',
            Value__c = 'yes',
            Join__c = 'all',
            Action__c = 'show'
        );
        Mapping__c referenceMapping = new Mapping__c(
            Name = 'Human reference mapping',
            Form_Version__c = version.Id,
            Target_Object__c = 'Account',
            Kind__c = 'reference',
            Matching_Field__c = 'Name',
            Order__c = 1
        );
        insert referenceMapping;
        Mapping__c repeatMapping = new Mapping__c(
            Name = 'Human repeat mapping',
            Form_Version__c = version.Id,
            Target_Object__c = 'Visit__c',
            Kind__c = 'repeat',
            Repeat_Question__c = repeatNode.Id,
            Parent_Mapping__c = referenceMapping.Id,
            Parent_Lookup_Field__c = 'Site__c',
            Collector_Field__c = 'Collector__c',
            Submission_Field__c = 'Submission__c',
            Order__c = 2
        );
        insert repeatMapping;
        insert new List<Field_Mapping__c>{
            new Field_Mapping__c(
                Mapping__c = referenceMapping.Id,
                Target_Field__c = 'Name',
                Transform__c = 'none',
                Source_Kind__c = 'question',
                Question__c = source.Id
            ),
            new Field_Mapping__c(
                Mapping__c = repeatMapping.Id,
                Target_Field__c = 'Answer__c',
                Transform__c = 'text_truncate',
                Source_Kind__c = 'question',
                Question__c = answer.Id
            ),
            new Field_Mapping__c(
                Mapping__c = repeatMapping.Id,
                Target_Field__c = 'Stage__c',
                Transform__c = 'none',
                Source_Kind__c = 'constant',
                Constant_Value__c = 'baseline'
            )
        };
    }

    @IsTest
    static void emitsPortableDeterministicBundleWithoutRecordIds() {
        createDefinitionOwnedByAnotherPrincipal();
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('portable');
            assignPermission(integration.Id, 'Kusanya_Integration');
        }

        System.runAs(integration) {
            Form_Version__c version = [SELECT Id FROM Form_Version__c LIMIT 1];
            Integer dmlBefore = Limits.getDmlStatements();
            Integer queriesBefore = Limits.getQueries();
            Map<String, Object> first = DefinitionSnapshotReader.readVersion(
                version.Id
            );
            Map<String, Object> second = DefinitionSnapshotReader.readVersion(
                version.Id
            );
            Assert.areEqual(dmlBefore, Limits.getDmlStatements());
            Assert.isTrue(Limits.getQueries() - queriesBefore <= 14);
            Assert.areEqual(JSON.serialize(first), JSON.serialize(second));
            Assert.areEqual(1, first.get('schemaVersion'));

            Map<String, Object> definition = (Map<String, Object>) first.get(
                'definition'
            );
            Map<String, Object> form = (Map<String, Object>) definition.get(
                'form'
            );
            Assert.isTrue(((String) form.get('key')).startsWith('form_'));
            Assert.areEqual('Synthetic snapshot', form.get('title'));
            Assert.areEqual(
                3,
                ((List<Object>) definition.get('questions')).size()
            );
            Assert.areEqual(
                1,
                ((List<Object>) definition.get('choiceLists')).size()
            );
            Assert.areEqual(
                1,
                ((List<Object>) definition.get('skipRules')).size()
            );

            Map<String, Object> mappingBundle = (Map<String, Object>) first.get(
                'mappingBundle'
            );
            List<Object> mappings = (List<Object>) mappingBundle.get(
                'mappings'
            );
            Assert.areEqual(2, mappings.size());
            Map<String, Object> child = (Map<String, Object>) mappings[1];
            Assert.areEqual('mapping_1', child.get('parentMapping'));
            Assert.areEqual(2, ((List<Object>) child.get('fields')).size());

            String serialized = JSON.serialize(first);
            for (SObject record : [
                SELECT Id
                FROM Question__c
            ]) {
                Assert.isFalse(serialized.contains(String.valueOf(record.Id)));
            }
            for (SObject record : [
                SELECT Id
                FROM Mapping__c
            ]) {
                Assert.isFalse(serialized.contains(String.valueOf(record.Id)));
            }
            Assert.isFalse(serialized.contains(String.valueOf(version.Id)));
        }
    }

    @IsTest
    static void integrationAndSupervisorReadCrossOwnerDefinitions() {
        createDefinitionOwnedByAnotherPrincipal();
        User integration;
        User supervisor;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            integration = createUser('integr');
            supervisor = createUser('super');
            assignPermission(integration.Id, 'Kusanya_Integration');
            assignPermission(supervisor.Id, 'Kusanya_Supervisor');
        }
        Id versionId = [SELECT Id FROM Form_Version__c LIMIT 1].Id;

        System.runAs(integration) {
            Map<String, Object> snapshot = DefinitionSnapshotReader.readVersion(
                versionId
            );
            Assert.areEqual(1, snapshot.get('schemaVersion'));
            Assert.areEqual(1, [SELECT COUNT() FROM Folder__c WITH USER_MODE]);
            Assert.areEqual(
                1,
                [SELECT COUNT() FROM Choice_List__c WITH USER_MODE]
            );
        }
        System.runAs(supervisor) {
            Map<String, Object> snapshot = DefinitionSnapshotReader.readVersion(
                versionId
            );
            Assert.areEqual(1, snapshot.get('schemaVersion'));
            Assert.areEqual(1, [SELECT COUNT() FROM Folder__c WITH USER_MODE]);
            Assert.areEqual(
                1,
                [SELECT COUNT() FROM Choice_List__c WITH USER_MODE]
            );
            Database.SaveResult result = Database.insert(
                new Form__c(
                    Name = 'Denied supervisor write',
                    Status__c = 'Draft'
                ),
                false,
                AccessLevel.USER_MODE
            );
            Assert.isFalse(result.isSuccess());
        }
    }

    @IsTest
    static void ungrantedPrincipalAndWrongIdentityFailClosed() {
        createDefinitionOwnedByAnotherPrincipal();
        User restricted;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            restricted = createUser('restr');
        }
        Id versionId = [SELECT Id FROM Form_Version__c LIMIT 1].Id;
        System.runAs(restricted) {
            try {
                DefinitionSnapshotReader.readVersion(versionId);
                Assert.fail('Expected a static refusal');
            } catch (DefinitionSnapshotReader.RefusedException error) {
                Assert.areEqual(
                    'DEFINITION_SNAPSHOT_REFUSED',
                    error.getMessage()
                );
            }
        }
        for (Id invalidId : new List<Id>{ null, UserInfo.getUserId() }) {
            try {
                DefinitionSnapshotReader.readVersion(invalidId);
                Assert.fail('Expected a static refusal');
            } catch (DefinitionSnapshotReader.RefusedException error) {
                Assert.areEqual(
                    'DEFINITION_SNAPSHOT_REFUSED',
                    error.getMessage()
                );
            }
        }
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
            LastName = 'Snapshot ' + marker,
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
