/**
 * Responsibility: exercise portable mapping storage and dependency integrity.
 * Synthetic definitions only; no target schema, target writes, compiler or C10 claim.
 */
@IsTest
private class MappingDefinitionModelTest {
    @IsTest
    static void storesReferenceWithTwoRepeatsAndNoMainMapping() {
        Form_Version__c version = createVersion('Synthetic mapping hierarchy');
        List<Question__c> repeats = new List<Question__c>{
            question(version.Id, 'visits', 'repeat'),
            question(version.Id, 'observations', 'repeat')
        };
        insert repeats;
        Mapping__c reference = mapping(
            version.Id,
            'Synthetic Account reference'
        );
        reference.Kind__c = 'reference';
        reference.Matching_Field__c = 'Name';
        insert reference;
        List<Mapping__c> children = new List<Mapping__c>();
        for (Question__c repeat : repeats) {
            Mapping__c child = mapping(version.Id, 'Synthetic repeat target');
            child.Kind__c = 'repeat';
            child.Repeat_Question__c = repeat.Id;
            child.Target_Object__c = 'Customer_Observation__c';
            child.Parent_Mapping__c = reference.Id;
            child.Parent_Lookup_Field__c = 'Account__c';
            child.Collector_Field__c = 'Collector__c';
            child.Submission_Field__c = 'Submission_Reference__c';
            children.add(child);
        }
        insert children;
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Mapping__c WHERE Kind__c = 'main']
        );
        Assert.areEqual(
            2,
            [SELECT COUNT() FROM Mapping__c WHERE Kind__c = 'repeat']
        );
        Id firstChildId = children[0].Id;
        Mapping__c saved = [
            SELECT
                Parent_Mapping__r.Target_Object__c,
                Parent_Mapping__r.Matching_Field__c,
                Repeat_Question__r.Type__c,
                Collector_Field__c,
                Submission_Field__c
            FROM Mapping__c
            WHERE Id = :firstChildId
        ];
        Assert.areEqual('Account', saved.Parent_Mapping__r.Target_Object__c);
        Assert.areEqual('Name', saved.Parent_Mapping__r.Matching_Field__c);
        Assert.areEqual('repeat', saved.Repeat_Question__r.Type__c);
        Assert.areEqual('Collector__c', saved.Collector_Field__c);
        Assert.areEqual('Submission_Reference__c', saved.Submission_Field__c);
    }

    @IsTest
    static void permitsIndependentTargetsAndPreservesCustomerIdentifiers() {
        Form_Version__c version = createVersion('Synthetic portable targets');
        Mapping__c first = mapping(version.Id, 'Synthetic first root');
        first.Target_Object__c = 'foreign__Observation__c';
        first.Record_Type__c = 'Field_Visit';
        first.Upsert_External_Id_Field__c = 'foreign__External_Id__c';
        first.Collector_Field__c = 'Customer_Collector__c';
        first.Submission_Field__c = 'Customer_Submission__c';
        Mapping__c second = mapping(version.Id, 'Synthetic second root');
        Mapping__c reference = mapping(version.Id, 'Synthetic ID reference');
        reference.Kind__c = 'reference';
        reference.Matching_Field__c = 'Id';
        insert new List<Mapping__c>{ first, second, reference };
        Mapping__c saved = [
            SELECT
                Target_Object__c,
                Record_Type__c,
                Upsert_External_Id_Field__c,
                Collector_Field__c,
                Submission_Field__c
            FROM Mapping__c
            WHERE Id = :first.Id
        ];
        Assert.areEqual('foreign__Observation__c', saved.Target_Object__c);
        Assert.areEqual('Field_Visit', saved.Record_Type__c);
        Assert.areEqual(
            'foreign__External_Id__c',
            saved.Upsert_External_Id_Field__c
        );
        Assert.areEqual('Customer_Collector__c', saved.Collector_Field__c);
        Assert.areEqual('Customer_Submission__c', saved.Submission_Field__c);
        Assert.areEqual(
            2,
            [SELECT COUNT() FROM Mapping__c WHERE Kind__c = 'main']
        );
    }

    @IsTest
    static void rejectsCrossVersionParentAndRepeatOnInsertAndUpdate() {
        Form_Version__c firstVersion = createVersion(
            'Synthetic first mapping scope'
        );
        Form_Version__c secondVersion = new Form_Version__c(
            Form__c = firstVersion.Form__c,
            Version_Number__c = 2
        );
        insert secondVersion;
        Mapping__c parent = mapping(
            secondVersion.Id,
            'Synthetic foreign parent'
        );
        insert parent;
        Question__c repeat = question(
            secondVersion.Id,
            'foreign_repeat',
            'repeat'
        );
        insert repeat;
        Mapping__c wrongParent = mapping(
            firstVersion.Id,
            'Synthetic wrong parent'
        );
        wrongParent.Parent_Mapping__c = parent.Id;
        wrongParent.Parent_Lookup_Field__c = 'Account__c';
        Mapping__c wrongRepeat = mapping(
            firstVersion.Id,
            'Synthetic wrong repeat'
        );
        wrongRepeat.Kind__c = 'repeat';
        wrongRepeat.Repeat_Question__c = repeat.Id;
        assertIndividualInsertsRejected(
            new List<Mapping__c>{ wrongParent, wrongRepeat }
        );

        Mapping__c local = mapping(firstVersion.Id, 'Synthetic valid local');
        insert local;
        local.Parent_Mapping__c = parent.Id;
        local.Parent_Lookup_Field__c = 'Account__c';
        assertRejected(Database.update(local, false));
        local.Parent_Mapping__c = null;
        local.Parent_Lookup_Field__c = null;
        local.Kind__c = 'repeat';
        local.Repeat_Question__c = repeat.Id;
        assertRejected(Database.update(local, false));
    }

    @IsTest
    static void requiresKindSpecificReferencesAndPairedParentLookup() {
        Form_Version__c version = createVersion('Synthetic mapping shape');
        Question__c ordinary = question(version.Id, 'answer', 'text');
        Question__c repeat = question(version.Id, 'items', 'repeat');
        insert new List<Question__c>{ ordinary, repeat };
        Mapping__c parent = mapping(version.Id, 'Synthetic parent');
        insert parent;
        List<Mapping__c> invalid = new List<Mapping__c>();
        Mapping__c missingRepeat = mapping(version.Id, 'Missing repeat');
        missingRepeat.Kind__c = 'repeat';
        invalid.add(missingRepeat);
        Mapping__c wrongType = mapping(version.Id, 'Wrong repeat type');
        wrongType.Kind__c = 'repeat';
        wrongType.Repeat_Question__c = ordinary.Id;
        invalid.add(wrongType);
        Mapping__c mainWithRepeat = mapping(version.Id, 'Main with repeat');
        mainWithRepeat.Repeat_Question__c = repeat.Id;
        invalid.add(mainWithRepeat);
        Mapping__c missingMatch = mapping(
            version.Id,
            'Reference without match'
        );
        missingMatch.Kind__c = 'reference';
        invalid.add(missingMatch);
        Mapping__c mainWithMatch = mapping(
            version.Id,
            'Main with matching field'
        );
        mainWithMatch.Matching_Field__c = 'Name';
        invalid.add(mainWithMatch);
        Mapping__c repeatWithMatch = mapping(
            version.Id,
            'Repeat with matching field'
        );
        repeatWithMatch.Kind__c = 'repeat';
        repeatWithMatch.Repeat_Question__c = repeat.Id;
        repeatWithMatch.Matching_Field__c = 'Name';
        invalid.add(repeatWithMatch);
        Mapping__c missingLookup = mapping(version.Id, 'Missing parent field');
        missingLookup.Parent_Mapping__c = parent.Id;
        invalid.add(missingLookup);
        Mapping__c missingParent = mapping(version.Id, 'Missing parent');
        missingParent.Parent_Lookup_Field__c = 'Account__c';
        invalid.add(missingParent);
        assertIndividualInsertsRejected(invalid);
    }

    @IsTest
    static void rejectsIdentifierTraversalAndNonPositiveOrFractionalOrder() {
        Form_Version__c version = createVersion(
            'Synthetic invalid identifiers'
        );
        List<Mapping__c> invalid = new List<Mapping__c>();
        for (
            String target : new List<String>{
                'Account.Name',
                'Account WHERE Name',
                'Account;DELETE',
                'foreign___Object__c',
                'Account_',
                '123',
                '_Account'
            }
        ) {
            Mapping__c definition = mapping(
                version.Id,
                'Synthetic invalid target'
            );
            definition.Target_Object__c = target;
            invalid.add(definition);
        }
        for (
            Schema.SObjectField fieldToken : new List<Schema.SObjectField>{
                Mapping__c.Record_Type__c,
                Mapping__c.Matching_Field__c,
                Mapping__c.Parent_Lookup_Field__c,
                Mapping__c.Upsert_External_Id_Field__c,
                Mapping__c.Collector_Field__c,
                Mapping__c.Submission_Field__c
            }
        ) {
            Mapping__c definition = mapping(
                version.Id,
                'Synthetic invalid field'
            );
            definition.put(fieldToken, 'Account.Name');
            invalid.add(definition);
        }
        for (Decimal orderValue : new List<Decimal>{ 0, -1, 1.5 }) {
            Mapping__c definition = mapping(
                version.Id,
                'Synthetic invalid order'
            );
            definition.Order__c = orderValue;
            invalid.add(definition);
        }
        assertIndividualInsertsRejected(invalid);
        Assert.areEqual(0, [SELECT COUNT() FROM Mapping__c]);
    }

    @IsTest
    static void handlerRejectsRatherThanNormalizesWhitespaceOrMissingValues() {
        Form_Version__c version = createVersion(
            'Synthetic raw identifier input'
        );
        Mapping__c whitespace = mapping(version.Id, 'Synthetic raw input');
        whitespace.Target_Object__c = ' Account';
        Mapping__c missingName = mapping(version.Id, ' ');
        Mapping__c missingTarget = mapping(
            version.Id,
            'Synthetic missing target'
        );
        missingTarget.Target_Object__c = null;
        Mapping__c missingVersion = mapping(null, 'Synthetic missing owner');
        Mapping__c missingOrder = mapping(
            version.Id,
            'Synthetic missing order'
        );
        missingOrder.Order__c = null;
        List<Mapping__c> definitions = new List<Mapping__c>{
            whitespace,
            missingName,
            missingTarget,
            missingVersion,
            missingOrder
        };
        Integer dmlBefore = Limits.getDmlStatements();
        for (Mapping__c definition : definitions) {
            MappingDefinitionHandler.validateMappings(
                new List<Mapping__c>{ definition },
                null
            );
            Assert.isTrue(definition.hasErrors());
        }
        Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        Assert.areEqual(' Account', whitespace.Target_Object__c);
    }

    @IsTest
    static void refusesCyclesAndRequiresStagedEdgeReversalForPartialDml() {
        Form_Version__c version = createVersion('Synthetic parent graph');
        Mapping__c parent = mapping(version.Id, 'Synthetic parent');
        Mapping__c child = mapping(version.Id, 'Synthetic child');
        insert new List<Mapping__c>{ parent, child };
        child.Parent_Mapping__c = parent.Id;
        child.Parent_Lookup_Field__c = 'Parent__c';
        update child;
        parent.Parent_Mapping__c = child.Id;
        parent.Parent_Lookup_Field__c = 'Parent__c';
        assertRejected(Database.update(parent, false));

        // The new graph alone is acyclic, but one failed row could leave the
        // old child's edge alongside the new parent edge. Reject both rows.
        child.Parent_Mapping__c = null;
        child.Parent_Lookup_Field__c = null;
        assertAllRejected(
            Database.update(new List<Mapping__c>{ parent, child }, false)
        );
        Assert.areEqual(
            parent.Id,
            [SELECT Parent_Mapping__c FROM Mapping__c WHERE Id = :child.Id]
            .Parent_Mapping__c
        );
        Assert.isNull(
            [SELECT Parent_Mapping__c FROM Mapping__c WHERE Id = :parent.Id]
            .Parent_Mapping__c
        );
        update child;
        update parent;
        Assert.areEqual(
            child.Id,
            [SELECT Parent_Mapping__c FROM Mapping__c WHERE Id = :parent.Id]
            .Parent_Mapping__c
        );
    }

    @IsTest
    static void rejectsSelfParentAndMovingVersionOwner() {
        Form_Version__c firstVersion = createVersion(
            'Synthetic immutable mapping owner'
        );
        Form_Version__c secondVersion = new Form_Version__c(
            Form__c = firstVersion.Form__c,
            Version_Number__c = 2
        );
        insert secondVersion;
        Mapping__c definition = mapping(
            firstVersion.Id,
            'Synthetic stable owner'
        );
        insert definition;
        definition.Parent_Mapping__c = definition.Id;
        definition.Parent_Lookup_Field__c = 'Parent__c';
        Assert.isFalse(Database.update(definition, false).isSuccess());

        // Construct a distinct input rather than assigning a non-reparentable
        // master-detail on a persisted SObject, which Salesforce can reject early.
        Mapping__c moved = mapping(secondVersion.Id, 'Synthetic moved owner');
        moved.Id = definition.Id;
        MappingDefinitionHandler.validateMappings(
            new List<Mapping__c>{ moved },
            new Map<Id, Mapping__c>{ definition.Id => definition }
        );
        Assert.isTrue(moved.hasErrors());
        Assert.areEqual(
            firstVersion.Id,
            [SELECT Form_Version__c FROM Mapping__c WHERE Id = :definition.Id]
            .Form_Version__c
        );
    }

    @IsTest
    static void mappedRepeatTypeMustRemainRepeatUntilUnlinked() {
        Form_Version__c version = createVersion(
            'Synthetic reverse repeat dependency'
        );
        Question__c repeat = question(version.Id, 'items', 'repeat');
        insert repeat;
        Mapping__c definition = mapping(
            version.Id,
            'Synthetic repeat dependency'
        );
        definition.Kind__c = 'repeat';
        definition.Repeat_Question__c = repeat.Id;
        insert definition;
        repeat.Type__c = 'text';
        repeat.Repeat_Mode__c = null;
        Integer queriesBefore = Limits.getQueries();
        assertRejected(Database.update(repeat, false));
        Assert.areEqual(queriesBefore + 4, Limits.getQueries());
        Assert.areEqual(
            'repeat',
            [SELECT Type__c FROM Question__c WHERE Id = :repeat.Id].Type__c
        );
        definition.Kind__c = 'main';
        definition.Repeat_Question__c = null;
        update definition;
        update repeat;
        Assert.areEqual(
            'text',
            [SELECT Type__c FROM Question__c WHERE Id = :repeat.Id].Type__c
        );
    }

    @IsTest
    static void bulkGraphWritesUseThreeQueriesAndNoInternalDml() {
        Form_Version__c version = createVersion('Synthetic bulk mapping graph');
        List<Mapping__c> definitions = new List<Mapping__c>();
        for (Integer index = 0; index < 200; index++) {
            definitions.add(mapping(version.Id, 'Synthetic mapping ' + index));
        }
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        insert definitions;
        Assert.areEqual(queriesBefore + 3, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
        for (Integer index = 1; index < definitions.size(); index++) {
            definitions[index].Parent_Mapping__c = definitions[index - 1].Id;
            definitions[index].Parent_Lookup_Field__c = 'Parent__c';
        }
        queriesBefore = Limits.getQueries();
        dmlBefore = Limits.getDmlStatements();
        update definitions;
        Assert.areEqual(queriesBefore + 3, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
        Assert.areEqual(200, [SELECT COUNT() FROM Mapping__c]);
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

    private static Mapping__c mapping(Id versionId, String name) {
        return new Mapping__c(
            Name = name,
            Form_Version__c = versionId,
            Target_Object__c = 'Account',
            Kind__c = 'main',
            Order__c = 1
        );
    }

    private static Question__c question(
        Id versionId,
        String name,
        String typeName
    ) {
        Question__c definition = new Question__c(
            Name = name,
            Form_Version__c = versionId,
            Type__c = typeName,
            Order__c = 1,
            Label__c = 'Synthetic mapping question'
        );
        if (typeName == 'repeat') {
            definition.Repeat_Mode__c = 'open';
        }
        return definition;
    }

    private static void assertAllRejected(List<Database.SaveResult> results) {
        for (Database.SaveResult result : results) {
            assertRejected(result);
        }
    }

    private static void assertIndividualInsertsRejected(
        List<Mapping__c> definitions
    ) {
        // Exercise each invalid contract independently: a different invalid row
        // must not hide an accidentally accepted shape via batch-wide rejection.
        for (Mapping__c definition : definitions) {
            assertRejected(Database.insert(definition, false));
        }
    }

    private static void assertRejected(Database.SaveResult result) {
        Assert.isFalse(result.isSuccess());
        Assert.areEqual(
            StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
            result.getErrors()[0].getStatusCode()
        );
    }
}
