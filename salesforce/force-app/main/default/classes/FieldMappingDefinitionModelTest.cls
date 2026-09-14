/**
 * Responsibility: exercise field mapping storage with synthetic definitions only.
 * No target writes, transform execution, collector identities or C10 claims.
 */
@IsTest
private class FieldMappingDefinitionModelTest {
    @IsTest
    static void sharesOnceOnlyAnswersAcrossTwoRepeatMappings() {
        Form_Version__c version = createVersion();
        Question__c once = question(version.Id, 'site', 'text');
        Question__c firstRepeat = question(version.Id, 'visits', 'repeat');
        Question__c secondRepeat = question(version.Id, 'checks', 'repeat');
        insert new List<Question__c>{ once, firstRepeat, secondRepeat };
        Question__c child = question(version.Id, 'visit_result', 'text');
        child.Parent__c = firstRepeat.Id;
        insert child;
        Mapping__c reference = mapping(version.Id, 'Account', 'reference');
        reference.Matching_Field__c = 'Name';
        insert reference;
        Mapping__c first = mapping(version.Id, 'Observation__c', 'repeat');
        first.Repeat_Question__c = firstRepeat.Id;
        first.Parent_Mapping__c = reference.Id;
        first.Parent_Lookup_Field__c = 'Site__c';
        Mapping__c second = mapping(version.Id, 'Observation__c', 'repeat');
        second.Repeat_Question__c = secondRepeat.Id;
        second.Parent_Mapping__c = reference.Id;
        second.Parent_Lookup_Field__c = 'Site__c';
        insert new List<Mapping__c>{ first, second };
        insert new List<Field_Mapping__c>{
            answer(reference.Id, once.Id, 'Name'),
            answer(first.Id, once.Id, 'Site_Name__c'),
            answer(second.Id, once.Id, 'Site_Name__c'),
            answer(first.Id, child.Id, 'Result__c')
        };
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Mapping__c WHERE Kind__c = 'main']
        );
        Assert.areEqual(4, [SELECT COUNT() FROM Field_Mapping__c]);
        Field_Mapping__c saved = [
            SELECT
                Question__r.Parent__c,
                Mapping__r.Repeat_Question__c,
                Match_Status__c,
                Transform__c
            FROM Field_Mapping__c
            WHERE Mapping__c = :second.Id
            LIMIT 1
        ];
        Assert.isNull(saved.Question__r.Parent__c);
        Assert.areEqual(secondRepeat.Id, saved.Mapping__r.Repeat_Question__c);
        Assert.isNull(
            saved.Match_Status__c,
            'Storage must not imply a schema match.'
        );
        Assert.areEqual('none', saved.Transform__c);
    }

    @IsTest
    static void representsZeroFalseWhitespaceAndBlankConstantsExplicitly() {
        Mapping__c owner = createMapping();
        List<Field_Mapping__c> fields = new List<Field_Mapping__c>();
        List<String> values = new List<String>{
            '0',
            'false',
            '  exact literal  ',
            null
        };
        for (Integer i = 0; i < values.size(); i++) {
            fields.add(
                new Field_Mapping__c(
                    Mapping__c = owner.Id,
                    Target_Field__c = 'Value_' + i + '__c',
                    Source_Kind__c = 'constant',
                    Constant_Value__c = values[i]
                )
            );
        }
        insert fields;
        Map<Id, Field_Mapping__c> saved = new Map<Id, Field_Mapping__c>(
            [
                SELECT Source_Kind__c, Question__c, Constant_Value__c
                FROM Field_Mapping__c
            ]
        );
        for (Integer i = 0; i < fields.size(); i++) {
            Assert.areEqual('constant', saved.get(fields[i].Id).Source_Kind__c);
            Assert.isNull(saved.get(fields[i].Id).Question__c);
            Assert.areEqual(
                values[i],
                saved.get(fields[i].Id).Constant_Value__c
            );
        }
    }

    @IsTest
    static void rejectsAmbiguousAndMissingSourcesButAllowsAtomicSourceChange() {
        Mapping__c owner = createMapping();
        Question__c source = question(owner.Form_Version__c, 'source', 'text');
        insert source;
        Field_Mapping__c both = answer(owner.Id, source.Id, 'Both__c');
        both.Constant_Value__c = 'literal';
        Field_Mapping__c constantWithQuestion = answer(
            owner.Id,
            source.Id,
            'Constant__c'
        );
        constantWithQuestion.Source_Kind__c = 'constant';
        Field_Mapping__c missing = answer(owner.Id, null, 'Missing__c');
        for (
            Database.SaveResult result : Database.insert(
                new List<Field_Mapping__c>{
                    both,
                    constantWithQuestion,
                    missing
                },
                false
            )
        ) {
            Assert.isFalse(result.isSuccess());
        }
        Field_Mapping__c valid = answer(owner.Id, source.Id, 'Valid__c');
        insert valid;
        valid.Source_Kind__c = 'constant';
        valid.Question__c = null;
        valid.Constant_Value__c = '0';
        update valid;
        Assert.areEqual(
            '0',
            [
                SELECT Constant_Value__c
                FROM Field_Mapping__c
                WHERE Id = :valid.Id
            ]
            .Constant_Value__c
        );
        valid.Source_Kind__c = 'question';
        valid.Question__c = source.Id;
        Assert.isFalse(Database.update(valid, false).isSuccess());
        valid.Constant_Value__c = null;
        update valid;
    }

    @IsTest
    static void rejectsCrossVersionQuestionOnInsertAndUpdate() {
        Mapping__c first = createMapping();
        Mapping__c second = createMapping();
        Question__c local = question(first.Form_Version__c, 'local', 'text');
        Question__c foreign = question(
            second.Form_Version__c,
            'foreign',
            'text'
        );
        insert new List<Question__c>{ local, foreign };
        Assert.isFalse(
            Database.insert(answer(first.Id, foreign.Id, 'Wrong__c'), false)
                .isSuccess()
        );
        Field_Mapping__c field = answer(first.Id, local.Id, 'Right__c');
        insert field;
        field.Question__c = foreign.Id;
        Assert.isFalse(Database.update(field, false).isSuccess());
        Assert.areEqual(
            local.Id,
            [SELECT Question__c FROM Field_Mapping__c WHERE Id = :field.Id]
            .Question__c
        );
    }

    @IsTest
    static void refusesReparentingEvenWhenTheQuestionIsInBothMappingsVersion() {
        Mapping__c first = createMapping();
        Mapping__c second = mapping(
            first.Form_Version__c,
            'Other_Target__c',
            'main'
        );
        insert second;
        Question__c source = question(first.Form_Version__c, 'source', 'text');
        insert source;
        Field_Mapping__c original = answer(first.Id, source.Id, 'Result__c');
        insert original;
        // Avoid assigning a new non-reparentable master to the persisted SObject:
        // Salesforce may refuse that assignment before DML. Exercise the guard
        // with a separate record while source version and target remain valid.
        Field_Mapping__c moved = answer(second.Id, source.Id, 'Result__c');
        moved.Id = original.Id;
        FieldMappingDefinitionHandler.validateFields(
            new List<Field_Mapping__c>{ moved },
            new Map<Id, Field_Mapping__c>{ original.Id => original }
        );
        Assert.isTrue(moved.hasErrors());
        Assert.areEqual(
            first.Id,
            [SELECT Mapping__c FROM Field_Mapping__c WHERE Id = :original.Id]
            .Mapping__c
        );
        Boolean rejected = false;
        try {
            original.Mapping__c = second.Id;
        } catch (SObjectException error) {
            rejected = true;
            Assert.isTrue(
                error.getMessage().startsWith('Field is not writeable: ')
            );
            Assert.isTrue(error.getMessage().endsWith('Mapping__c'));
        }
        Assert.isTrue(
            rejected,
            'Persisted field-mapping ownership must be immutable.'
        );
    }

    @IsTest
    static void derivesCaseInsensitivePerMappingKeysAndPreservesTargetSpelling() {
        Mapping__c owner = createMapping();
        Field_Mapping__c first = constant(owner.Id, 'vendor__Result__c');
        first.Target_Key__c = 'caller supplied';
        insert first;
        String expected = EncodingUtil.convertToHex(
            Crypto.generateDigest(
                'SHA-256',
                Blob.valueOf(String.valueOf(owner.Id) + ':vendor__result__c')
            )
        );
        Field_Mapping__c stored = [
            SELECT Target_Field__c, Target_Key__c
            FROM Field_Mapping__c
            WHERE Id = :first.Id
        ];
        Assert.areEqual('vendor__Result__c', stored.Target_Field__c);
        Assert.areEqual(expected, stored.Target_Key__c);
        Database.SaveResult duplicate = Database.insert(
            constant(owner.Id, 'VENDOR__RESULT__C'),
            false
        );
        Assert.isFalse(duplicate.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicate.getErrors()[0].getStatusCode()
        );
        Mapping__c other = createMapping();
        insert constant(other.Id, 'vendor__Result__c');
        Field_Mapping__c renamed = constant(owner.Id, 'Other__c');
        insert renamed;
        renamed.Target_Field__c = 'vendor__RESULT__c';
        Assert.isFalse(Database.update(renamed, false).isSuccess());
        first.Target_Field__c = 'New_Result__c';
        first.Target_Key__c = 'override';
        update first;
        Assert.areNotEqual(
            expected,
            [SELECT Target_Key__c FROM Field_Mapping__c WHERE Id = :first.Id]
            .Target_Key__c
        );
    }

    @IsTest
    static void refusesTraversalAndExecutableTargetText() {
        Mapping__c owner = createMapping();
        List<Field_Mapping__c> fields = new List<Field_Mapping__c>();
        for (
            String target : new List<String>{
                'Account.Name',
                'Name FROM User',
                'Name,Id',
                'https://example.invalid',
                'x;delete',
                'Bad___c',
                'Trailing_'
            }
        ) {
            fields.add(constant(owner.Id, target));
        }
        for (Database.SaveResult result : Database.insert(fields, false)) {
            Assert.isFalse(result.isSuccess());
        }
        insert constant(owner.Id, 'Unknown_But_Portable__c');
    }

    @IsTest
    static void storesEveryC4TransformWithoutExecutingIt() {
        Mapping__c owner = createMapping();
        List<String> transforms = new List<String>{
            'none',
            'picklist_match',
            'multi_select_join',
            'lookup_by_external_id',
            'date_only',
            'boolean_yes_no',
            'number',
            'text_truncate',
            'geopoint_lat',
            'geopoint_lng',
            'geopoint_accuracy',
            'file_url'
        };
        List<Field_Mapping__c> fields = new List<Field_Mapping__c>();
        for (Integer i = 0; i < transforms.size(); i++) {
            Field_Mapping__c field = constant(owner.Id, 'Target_' + i + '__c');
            field.Transform__c = transforms[i];
            field.Constant_Value__c = 'not executed';
            field.Match_Status__c = 'warning';
            field.Match_Detail__c = 'Synthetic author annotation, not publish evidence';
            fields.add(field);
        }
        insert fields;
        List<Field_Mapping__c> saved = [
            SELECT Constant_Value__c
            FROM Field_Mapping__c
        ];
        Assert.areEqual(12, saved.size());
        for (Field_Mapping__c field : saved)
            Assert.areEqual('not executed', field.Constant_Value__c);
        Field_Mapping__c invalid = constant(owner.Id, 'Invalid__c');
        invalid.Transform__c = 'execute_script';
        Assert.isFalse(Database.insert(invalid, false).isSuccess());
    }

    @IsTest
    static void partialInsertKeepsOnlyIndependentValidRows() {
        Mapping__c owner = createMapping();
        Question__c source = question(owner.Form_Version__c, 'source', 'text');
        insert source;
        List<Database.SaveResult> results = Database.insert(
            new List<Field_Mapping__c>{
                constant(owner.Id, 'Good__c'),
                answer(owner.Id, null, 'Bad__c'),
                answer(owner.Id, source.Id, 'Answer__c')
            },
            false
        );
        Assert.isTrue(results[0].isSuccess());
        Assert.isFalse(results[1].isSuccess());
        Assert.isTrue(results[2].isSuccess());
        Assert.areEqual(2, [SELECT COUNT() FROM Field_Mapping__c]);
    }

    @IsTest
    static void twoHundredFieldWritesHaveFixedQueriesAndNoInternalDml() {
        Mapping__c owner = createMapping();
        Question__c source = question(owner.Form_Version__c, 'source', 'text');
        insert source;
        List<Field_Mapping__c> fields = new List<Field_Mapping__c>();
        for (Integer i = 0; i < 200; i++)
            fields.add(answer(owner.Id, source.Id, 'Value_' + i + '__c'));
        Test.startTest();
        Integer queries = Limits.getQueries();
        Integer statements = Limits.getDmlStatements();
        insert fields;
        Assert.areEqual(2, Limits.getQueries() - queries);
        Assert.areEqual(1, Limits.getDmlStatements() - statements);
        for (Field_Mapping__c field : fields)
            field.Transform__c = 'text_truncate';
        queries = Limits.getQueries();
        statements = Limits.getDmlStatements();
        update fields;
        Assert.areEqual(2, Limits.getQueries() - queries);
        Assert.areEqual(1, Limits.getDmlStatements() - statements);
        Test.stopTest();
    }

    private static Form_Version__c createVersion() {
        Form__c form = new Form__c(Name = 'Synthetic mapping form');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        return version;
    }
    private static Mapping__c createMapping() {
        Mapping__c result = mapping(
            createVersion().Id,
            'Observation__c',
            'main'
        );
        insert result;
        return result;
    }
    private static Mapping__c mapping(
        Id versionId,
        String target,
        String kind
    ) {
        return new Mapping__c(
            Name = 'Synthetic mapping',
            Form_Version__c = versionId,
            Target_Object__c = target,
            Kind__c = kind,
            Order__c = 1
        );
    }
    private static Question__c question(
        Id versionId,
        String name,
        String kind
    ) {
        return new Question__c(
            Name = name,
            Form_Version__c = versionId,
            Type__c = kind,
            Label__c = 'Synthetic label',
            Order__c = 1,
            Repeat_Mode__c = kind == 'repeat' ? 'open' : null
        );
    }
    private static Field_Mapping__c answer(
        Id ownerId,
        Id questionId,
        String target
    ) {
        return new Field_Mapping__c(
            Mapping__c = ownerId,
            Question__c = questionId,
            Target_Field__c = target,
            Source_Kind__c = 'question'
        );
    }
    private static Field_Mapping__c constant(Id ownerId, String target) {
        return new Field_Mapping__c(
            Mapping__c = ownerId,
            Target_Field__c = target,
            Source_Kind__c = 'constant'
        );
    }
}
