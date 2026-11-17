/**
 * Responsibility: prove raw XML normalization, repeat-cardinality policy,
 * typed projections, unknown-node retention, idempotency and bulk bounds.
 */
@IsTest
private class SubmissionAnswerParserTest {
    @IsTest
    static void storesNormalizedGraphTypedValuesAndWarningsOnce() {
        User integration = integrationUser('ansnorm');
        System.runAs(integration) {
            Form_Version__c version = createVersion('Answer normalization');
            Question__c section = question(
                version.Id,
                'household',
                'section',
                1
            );
            insert section;
            Question__c count = question(version.Id, 'members', 'integer', 2);
            count.Parent__c = section.Id;
            insert count;
            Question__c repeat = question(version.Id, 'person', 'repeat', 3);
            repeat.Parent__c = section.Id;
            repeat.Repeat_Mode__c = 'from_answer';
            repeat.Repeat_Source_Question__c = count.Id;
            repeat.Repeat_Max__c = 3;
            insert repeat;
            Question__c personName = question(
                version.Id,
                'person_name',
                'text',
                4
            );
            personName.Parent__c = repeat.Id;
            Question__c birthDate = question(
                version.Id,
                'birth_date',
                'date',
                5
            );
            birthDate.Parent__c = repeat.Id;
            insert new List<Question__c>{ personName, birthDate };
            Choice_List__c yesNo = new Choice_List__c(Name = 'Yes or no');
            insert yesNo;
            Question__c consent = question(
                version.Id,
                'consent',
                'select_one',
                6
            );
            consent.Parent__c = section.Id;
            consent.Choice_List__c = yesNo.Id;
            insert consent;
            Choice__c yes = new Choice__c(
                Choice_List__c = yesNo.Id,
                Value__c = 'yes',
                Label__c = 'Yes',
                Order__c = 1
            );
            insert yes;

            Submission__c submission = received(version.Id, 1);
            insert submission;
            Blob xml = Blob.valueOf(
                '<data><household><members>1</members>' +
                    '<person><person_name>Ada</person_name><birth_date>2020-01-02</birth_date></person>' +
                    '<person><person_name>Trailing</person_name><birth_date>2021-03-04</birth_date></person>' +
                    '<consent>yes</consent></household><legacy>retained</legacy>' +
                    '<meta><instanceID>uuid:00000000-0000-4000-8000-000000000001</instanceID></meta></data>'
            );

            Assert.areEqual(
                new Set<Id>(),
                SubmissionAnswerParser.store(
                    new Map<Id, Blob>{ submission.Id => xml }
                )
            );

            List<Answer__c> answers = [
                SELECT
                    Id,
                    Node_Name__c,
                    Question__c,
                    Parent_Answer__c,
                    Repeat_Path__c,
                    Repeat_Index__c,
                    Value__c,
                    Numeric_Value__c,
                    Date_Value__c,
                    Choice__c
                FROM Answer__c
                WHERE Submission__c = :submission.Id
                ORDER BY Id
            ];
            Assert.areEqual(7, answers.size());
            Map<String, Answer__c> byName = new Map<String, Answer__c>();
            for (Answer__c answer : answers)
                byName.put(answer.Node_Name__c, answer);
            Assert.areEqual(
                Decimal.valueOf(1),
                byName.get('members').Numeric_Value__c
            );
            Assert.areEqual(
                Date.newInstance(2020, 1, 2),
                byName.get('birth_date').Date_Value__c
            );
            Assert.areEqual(
                '/person[1]',
                byName.get('person_name').Repeat_Path__c
            );
            Assert.areEqual(1, byName.get('person_name').Repeat_Index__c);
            Assert.areEqual(yes.Id, byName.get('consent').Choice__c);
            Assert.areEqual(
                byName.get('person').Id,
                byName.get('person_name').Parent_Answer__c
            );
            Assert.isNull(byName.get('legacy').Question__c);
            Assert.areEqual('retained', byName.get('legacy').Value__c);
            Error_Log__c warning = [
                SELECT Stage__c, Error_Code__c, Detail__c
                FROM Error_Log__c
                WHERE Submission__c = :submission.Id
            ];
            Assert.areEqual('parse', warning.Stage__c);
            Assert.areEqual('UNKNOWN_NODE', warning.Error_Code__c);
            Assert.isTrue(warning.Detail__c.contains('legacy'));
            Assert.isNotNull(
                [
                    SELECT Parsed_At__c
                    FROM Submission__c
                    WHERE Id = :submission.Id
                ]
                .Parsed_At__c
            );

            Assert.areEqual(
                new Set<Id>(),
                SubmissionAnswerParser.store(
                    new Map<Id, Blob>{ submission.Id => xml }
                )
            );
            Assert.areEqual(
                7,
                [
                    SELECT COUNT()
                    FROM Answer__c
                    WHERE Submission__c = :submission.Id
                ]
            );
            Assert.areEqual(
                1,
                [
                    SELECT COUNT()
                    FROM Error_Log__c
                    WHERE Submission__c = :submission.Id
                ]
            );
        }
    }

    @IsTest
    static void refusesPlacementDeficitDoctypeAndPreexistingPartialState() {
        User integration = integrationUser('ansdeny');
        System.runAs(integration) {
            Form_Version__c version = createVersion('Answer refusals');
            Question__c section = question(version.Id, 'group', 'section', 1);
            insert section;
            Question__c count = question(version.Id, 'count', 'integer', 2);
            count.Parent__c = section.Id;
            insert count;
            Question__c repeat = question(version.Id, 'row', 'repeat', 3);
            repeat.Parent__c = section.Id;
            repeat.Repeat_Mode__c = 'from_answer';
            repeat.Repeat_Source_Question__c = count.Id;
            repeat.Repeat_Max__c = 2;
            insert repeat;
            Question__c value = question(version.Id, 'value', 'text', 4);
            value.Parent__c = repeat.Id;
            insert value;
            Question__c amount = question(version.Id, 'amount', 'decimal', 5);
            amount.Parent__c = section.Id;
            insert amount;

            assertRefused(
                received(version.Id, 10),
                '<data><count>1</count></data>'
            );
            assertRefused(
                received(version.Id, 11),
                '<data><group><count>2</count><row><value>one</value></row></group></data>'
            );
            assertRefused(
                received(version.Id, 12),
                '<!DOCTYPE data [<!ENTITY x "unsafe">]><data><group><count>0</count></group></data>'
            );
            assertRefused(
                received(version.Id, 16),
                '<data><group><count>0</count><amount>1234567890123.000000</amount></group></data>'
            );

            Submission__c partial = received(version.Id, 13);
            insert partial;
            insert new Answer__c(
                Submission__c = partial.Id,
                Node_Name__c = 'legacy',
                Value__c = 'partial'
            );
            Assert.areEqual(
                new Set<Id>{ partial.Id },
                SubmissionAnswerParser.store(
                    new Map<Id, Blob>{
                        partial.Id => Blob.valueOf(
                            '<data><group><count>0</count></group></data>'
                        )
                    }
                )
            );
            Assert.isNull(
                [
                    SELECT Parsed_At__c
                    FROM Submission__c
                    WHERE Id = :partial.Id
                ]
                .Parsed_At__c
            );

            Submission__c valid = received(version.Id, 14);
            Submission__c invalid = received(version.Id, 15);
            insert new List<Submission__c>{ valid, invalid };
            Assert.areEqual(
                new Set<Id>{ invalid.Id },
                SubmissionAnswerParser.store(
                    new Map<Id, Blob>{
                        valid.Id => Blob.valueOf(
                            '<data><group><count>0</count></group></data>'
                        ),
                        invalid.Id => Blob.valueOf(
                            '<data><group><count>1</count></group></data>'
                        )
                    }
                )
            );
            Assert.areEqual(
                2,
                [SELECT COUNT() FROM Answer__c WHERE Submission__c = :valid.Id]
            );
            Assert.areEqual(
                0,
                [
                    SELECT COUNT()
                    FROM Answer__c
                    WHERE Submission__c = :invalid.Id
                ]
            );
            Set<Id> isolatedIds = new Set<Id>{ valid.Id, invalid.Id };
            Map<Id, Submission__c> isolated = new Map<Id, Submission__c>(
                [
                    SELECT Parsed_At__c
                    FROM Submission__c
                    WHERE Id IN :isolatedIds
                ]
            );
            Assert.isNotNull(isolated.get(valid.Id).Parsed_At__c);
            Assert.isNull(isolated.get(invalid.Id).Parsed_At__c);
        }
    }

    @IsTest
    static void normalizesTwoHundredSubmissionsWithThirtyAnswersEach() {
        User integration = integrationUser('ansbulk');
        System.runAs(integration) {
            Form_Version__c version = createVersion(
                'Bulk answer normalization'
            );
            List<Question__c> questions = new List<Question__c>();
            String body = '';
            for (Integer index = 0; index < 30; index++) {
                String name = 'answer_' + index;
                questions.add(question(version.Id, name, 'text', index + 1));
                body += '<' + name + '>value</' + name + '>';
            }
            insert questions;
            List<Submission__c> submissions = new List<Submission__c>();
            for (Integer index = 0; index < 200; index++)
                submissions.add(received(version.Id, 1000 + index));
            insert submissions;
            Map<Id, Blob> payloads = new Map<Id, Blob>();
            Blob xml = Blob.valueOf('<data>' + body + '</data>');
            for (Submission__c submission : submissions)
                payloads.put(submission.Id, xml);

            Test.startTest();
            Assert.areEqual(
                new Set<Id>(),
                SubmissionAnswerParser.store(payloads)
            );
            Test.stopTest();

            Set<Id> submissionIds = new Map<Id, Submission__c>(submissions)
                .keySet();

            Assert.areEqual(
                6000,
                [
                    SELECT COUNT()
                    FROM Answer__c
                    WHERE Submission__c IN :submissionIds
                ]
            );
            Assert.areEqual(
                200,
                [
                    SELECT COUNT()
                    FROM Submission__c
                    WHERE Id IN :submissionIds AND Parsed_At__c != NULL
                ]
            );
        }
    }

    @IsTest
    static void enforcesSubmittedCountsForTopLevelRepeats() {
        User integration = integrationUser('anstop');
        System.runAs(integration) {
            Form_Version__c version = createVersion('Top-level repeats');
            Question__c count = question(version.Id, 'members', 'integer', 1);
            insert count;
            Question__c repeat = question(version.Id, 'person', 'repeat', 2);
            repeat.Repeat_Mode__c = 'from_answer';
            repeat.Repeat_Source_Question__c = count.Id;
            repeat.Repeat_Max__c = 3;
            insert repeat;
            Question__c personName = question(
                version.Id,
                'person_name',
                'text',
                3
            );
            personName.Parent__c = repeat.Id;
            insert personName;

            assertRefused(
                received(version.Id, 20),
                '<data><members>2</members><person><person_name>Only</person_name></person></data>'
            );

            Submission__c trailing = received(version.Id, 21);
            insert trailing;
            String xml =
                '<data><members>1</members>' +
                '<person><person_name>Kept</person_name></person>' +
                '<person><person_name>Trailing two</person_name></person>' +
                '<person><person_name>Trailing three</person_name></person></data>';
            Assert.areEqual(
                new Set<Id>(),
                SubmissionAnswerParser.store(
                    new Map<Id, Blob>{ trailing.Id => Blob.valueOf(xml) }
                )
            );
            List<Answer__c> answers = [
                SELECT Node_Name__c, Repeat_Path__c
                FROM Answer__c
                WHERE Submission__c = :trailing.Id
            ];
            Assert.areEqual(3, answers.size());
            for (Answer__c answer : answers) {
                Assert.isFalse(
                    answer.Repeat_Path__c != null &&
                    (answer.Repeat_Path__c.contains('[2]') ||
                    answer.Repeat_Path__c.contains('[3]'))
                );
            }
            Assert.isNotNull(
                [
                    SELECT Parsed_At__c
                    FROM Submission__c
                    WHERE Id = :trailing.Id
                ]
                .Parsed_At__c
            );
        }
    }

    private static void assertRefused(Submission__c submission, String xml) {
        insert submission;
        Assert.areEqual(
            new Set<Id>{ submission.Id },
            SubmissionAnswerParser.store(
                new Map<Id, Blob>{ submission.Id => Blob.valueOf(xml) }
            )
        );
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Answer__c WHERE Submission__c = :submission.Id]
        );
    }

    private static Form_Version__c createVersion(String name) {
        Form__c form = new Form__c(Name = name);
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        return version;
    }

    private static Question__c question(
        Id versionId,
        String name,
        String typeName,
        Integer orderValue
    ) {
        Question__c result = new Question__c(
            Form_Version__c = versionId,
            Name = name,
            Type__c = typeName,
            Order__c = orderValue,
            Label__c = 'Synthetic ' + name
        );
        if (typeName == 'repeat')
            result.Repeat_Mode__c = 'open';
        return result;
    }

    private static Submission__c received(Id versionId, Integer suffix) {
        String tail = ('000000000000' + String.valueOf(suffix)).right(12);
        return new Submission__c(
            Form_Version__c = versionId,
            Instance_Id__c = 'uuid:00000000-0000-4000-8000-' + tail,
            Channel__c = 'phone',
            Received_At__c = DateTime.now(),
            XML_Hash__c = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            Raw_XML_Version__c = '068000000000000AAA',
            Status__c = 'Received',
            Attempts__c = 0
        );
    }

    private static User integrationUser(String marker) {
        User integration;
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Profile profile = [
                SELECT Id
                FROM Profile
                WHERE Name = 'Standard User'
                LIMIT 1
            ];
            String unique =
                marker +
                '.' +
                String.valueOf(DateTime.now().getTime());
            integration = new User(
                Alias = marker.left(8),
                Email = unique + '@example.invalid',
                EmailEncodingKey = 'UTF-8',
                LastName = 'Answer parser ' + marker,
                LanguageLocaleKey = 'en_US',
                LocaleSidKey = 'en_US',
                ProfileId = profile.Id,
                TimeZoneSidKey = 'Africa/Nairobi',
                Username = unique + '@example.invalid'
            );
            insert integration;
            PermissionSet permission = [
                SELECT Id
                FROM PermissionSet
                WHERE Name = 'Kusanya_Integration'
                LIMIT 1
            ];
            insert new PermissionSetAssignment(
                AssigneeId = integration.Id,
                PermissionSetId = permission.Id
            );
        }
        return integration;
    }
}
