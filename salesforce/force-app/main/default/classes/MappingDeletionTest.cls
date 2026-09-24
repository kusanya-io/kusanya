/**
 * Responsibility: exercise direct definition guards and ancestor mapping cascades.
 * Synthetic draft storage only; undelete and published/submission lifecycle are deferred.
 */
@IsTest
private class MappingDeletionTest {
    @IsTest
    static void deletingParentRequiresAllMappingDependantsInTheBatch() {
        Form_Version__c version = createVersion(
            'Synthetic mapping delete parent'
        );
        Mapping__c parent = mapping(version.Id, 'Synthetic parent');
        insert parent;
        Mapping__c first = mapping(version.Id, 'Synthetic first child');
        first.Parent_Mapping__c = parent.Id;
        first.Parent_Lookup_Field__c = 'Parent__c';
        Mapping__c second = mapping(version.Id, 'Synthetic second child');
        second.Parent_Mapping__c = parent.Id;
        second.Parent_Lookup_Field__c = 'Parent__c';
        insert new List<Mapping__c>{ first, second };
        Database.DeleteResult refused = Database.delete(parent, false);
        assertRejected(refused);
        Assert.areEqual(
            'Cannot delete mappings referenced by mappings outside this delete batch.',
            refused.getErrors()[0].getMessage()
        );
        Assert.areEqual(
            parent.Id,
            [SELECT Parent_Mapping__c FROM Mapping__c WHERE Id = :first.Id]
            .Parent_Mapping__c
        );
        assertAllDeleted(
            Database.delete(
                new List<Mapping__c>{ parent, first, second },
                false
            )
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Mapping__c]);
    }

    @IsTest
    static void outsideMappingRejectsEntirePartialDeleteBatchWithoutLeaks() {
        Form_Version__c version = createVersion(
            'Synthetic partial mapping delete'
        );
        Mapping__c parent = mapping(version.Id, 'Synthetic parent');
        Mapping__c independent = mapping(version.Id, 'Synthetic independent');
        insert new List<Mapping__c>{ parent, independent };
        Mapping__c outside = mapping(version.Id, 'Hidden synthetic dependant');
        outside.Parent_Mapping__c = parent.Id;
        outside.Parent_Lookup_Field__c = 'Parent__c';
        insert outside;
        List<Database.DeleteResult> results = Database.delete(
            new List<Mapping__c>{ parent, independent },
            false
        );
        for (Database.DeleteResult result : results) {
            assertRejected(result);
            Assert.isFalse(
                result.getErrors()[0]
                    .getMessage()
                    .contains(String.valueOf(outside.Id))
            );
            Assert.isFalse(
                result.getErrors()[0].getMessage().contains(outside.Name)
            );
        }
        Assert.areEqual(3, [SELECT COUNT() FROM Mapping__c]);
    }

    @IsTest
    static void mappedRepeatCannotBeDeletedUntilMappingRemoved() {
        Form_Version__c version = createVersion(
            'Synthetic repeat delete guard'
        );
        Question__c repeat = question(version.Id, 'items', 'repeat');
        insert repeat;
        Mapping__c definition = mapping(version.Id, 'Synthetic repeat mapping');
        definition.Kind__c = 'repeat';
        definition.Repeat_Question__c = repeat.Id;
        insert definition;
        assertRejected(Database.delete(repeat, false));
        Assert.areEqual(
            repeat.Id,
            [
                SELECT Repeat_Question__c
                FROM Mapping__c
                WHERE Id = :definition.Id
            ]
            .Repeat_Question__c
        );
        delete definition;
        delete repeat;
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
    }

    @IsTest
    static void mappedAnswerCannotBeDeletedUntilFieldMappingRemoved() {
        Form_Version__c version = createVersion(
            'Synthetic answer delete guard'
        );
        Question__c answer = question(version.Id, 'answer', 'text');
        Question__c independent = question(version.Id, 'independent', 'text');
        insert new List<Question__c>{ answer, independent };
        Mapping__c definition = mapping(version.Id, 'Synthetic answer mapping');
        insert definition;
        Field_Mapping__c fieldMapping = new Field_Mapping__c(
            Mapping__c = definition.Id,
            Source_Kind__c = 'question',
            Question__c = answer.Id,
            Target_Field__c = 'Name',
            Transform__c = 'none'
        );
        insert fieldMapping;
        List<Database.DeleteResult> results = Database.delete(
            new List<Question__c>{ answer, independent },
            false
        );
        for (Database.DeleteResult result : results) {
            assertRejected(result);
        }
        Assert.areEqual(
            answer.Id,
            [
                SELECT Question__c
                FROM Field_Mapping__c
                WHERE Id = :fieldMapping.Id
            ]
            .Question__c
        );
        delete fieldMapping;
        assertAllDeleted(
            Database.delete(new List<Question__c>{ answer, independent }, false)
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
    }

    @IsTest
    static void deletingDraftFormCascadesQuestionsMappingsAndFieldMappings() {
        Form__c form = new Form__c(Name = 'Synthetic complete mapping cascade');
        insert form;
        versionWithMappings(form.Id, 1);
        Assert.areEqual(2, [SELECT COUNT() FROM Mapping__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Field_Mapping__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        delete form;
        // Existing owner cleanup removes only skip rules; native cascades bypass
        // direct question/mapping delete guards and remove all owned definitions.
        Assert.areEqual(queriesBefore + 3, Limits.getQueries());
        Assert.areEqual(dmlBefore + 2, Limits.getDmlStatements());
        Assert.areEqual(0, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Skip_Rule__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Mapping__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Field_Mapping__c]);
    }

    @IsTest
    static void directVersionCascadePreservesSiblingMappingDefinitions() {
        Form__c form = new Form__c(
            Name = 'Synthetic mapping sibling preservation'
        );
        insert form;
        Form_Version__c first = versionWithMappings(form.Id, 1);
        Form_Version__c sibling = versionWithMappings(form.Id, 2);
        delete first;
        Assert.areEqual(1, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Assert.areEqual(
            2,
            [SELECT COUNT() FROM Mapping__c WHERE Form_Version__c = :sibling.Id]
        );
        Assert.areEqual(
            1,
            [
                SELECT COUNT()
                FROM Field_Mapping__c
                WHERE Mapping__r.Form_Version__c = :sibling.Id
            ]
        );
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Mapping__c WHERE Form_Version__c = :first.Id]
        );
        Assert.areEqual(
            0,
            [
                SELECT COUNT()
                FROM Field_Mapping__c
                WHERE Mapping__r.Form_Version__c = :first.Id
            ]
        );
    }

    @IsTest
    static void outerRollbackRestoresExecutedMappingCascade() {
        Form__c form = new Form__c(Name = 'Synthetic mapping rollback');
        insert form;
        Form_Version__c version = versionWithMappings(form.Id, 1);
        Savepoint checkpoint = Database.setSavepoint();
        delete form;
        Assert.areEqual(0, [SELECT COUNT() FROM Mapping__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Field_Mapping__c]);
        Database.rollback(checkpoint);
        Assert.areEqual(
            2,
            [SELECT COUNT() FROM Mapping__c WHERE Form_Version__c = :version.Id]
        );
        Assert.areEqual(
            1,
            [
                SELECT COUNT()
                FROM Field_Mapping__c
                WHERE Mapping__r.Form_Version__c = :version.Id
            ]
        );
        Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Mapping__c child = [
            SELECT Parent_Mapping__c, Repeat_Question__c
            FROM Mapping__c
            WHERE Kind__c = 'repeat'
        ];
        Assert.isNotNull(child.Parent_Mapping__c);
        Assert.isNotNull(child.Repeat_Question__c);
        Assert.isNotNull(
            [SELECT Question__c FROM Field_Mapping__c LIMIT 1].Question__c
        );
    }

    @IsTest
    static void partialFormDeletePreservesFailedOwnersMappingReferences() {
        Form__c blocked = new Form__c(Name = 'Synthetic blocked mapping form');
        Form__c clean = new Form__c(Name = 'Synthetic clean mapping form');
        insert new List<Form__c>{ blocked, clean };
        Form_Version__c blockedVersion = versionWithMappings(blocked.Id, 1);
        versionWithMappings(clean.Id, 1);
        addInlineBlocker(blockedVersion.Id);
        Mapping__c originalMapping = savedRepeatMapping(blockedVersion.Id);
        Field_Mapping__c originalFieldMapping = savedFieldMapping(
            blockedVersion.Id
        );

        List<Database.DeleteResult> results = Database.delete(
            new List<Form__c>{ blocked, clean },
            false
        );

        Assert.isFalse(results[0].isSuccess());
        Assert.areEqual(
            StatusCode.DELETE_FAILED,
            results[0].getErrors()[0].getStatusCode()
        );
        Assert.isTrue(results[1].isSuccess());
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Form__c WHERE Id = :blocked.Id]
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Form__c WHERE Id = :clean.Id]);
        assertOnlyBlockedDefinitionsRemain(
            blockedVersion.Id,
            originalMapping,
            originalFieldMapping
        );
    }

    @IsTest
    static void partialVersionDeletePreservesFailedOwnersMappingReferences() {
        Form__c form = new Form__c(Name = 'Synthetic partial mapping versions');
        insert form;
        Form_Version__c blocked = versionWithMappings(form.Id, 1);
        Form_Version__c clean = versionWithMappings(form.Id, 2);
        addInlineBlocker(blocked.Id);
        Mapping__c originalMapping = savedRepeatMapping(blocked.Id);
        Field_Mapping__c originalFieldMapping = savedFieldMapping(blocked.Id);

        List<Database.DeleteResult> results = Database.delete(
            new List<Form_Version__c>{ blocked, clean },
            false
        );

        Assert.isFalse(results[0].isSuccess());
        Assert.areEqual(
            StatusCode.DELETE_FAILED,
            results[0].getErrors()[0].getStatusCode()
        );
        Assert.isTrue(results[1].isSuccess());
        Assert.areEqual(1, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Form_Version__c WHERE Id = :clean.Id]
        );
        assertOnlyBlockedDefinitionsRemain(
            blocked.Id,
            originalMapping,
            originalFieldMapping
        );
    }

    @IsTest
    static void bulkMappingDeleteUsesOneQueryAndNoInternalDml() {
        Form_Version__c version = createVersion(
            'Synthetic bulk mapping deletion'
        );
        List<Mapping__c> definitions = new List<Mapping__c>();
        for (Integer index = 0; index < 200; index++) {
            definitions.add(mapping(version.Id, 'Synthetic mapping ' + index));
        }
        insert definitions;
        for (Integer index = 1; index < definitions.size(); index++) {
            definitions[index].Parent_Mapping__c = definitions[index - 1].Id;
            definitions[index].Parent_Lookup_Field__c = 'Parent__c';
        }
        update definitions;
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        assertAllDeleted(Database.delete(definitions, false));
        Assert.areEqual(queriesBefore + 2, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
        Assert.areEqual(0, [SELECT COUNT() FROM Mapping__c]);
    }

    private static Form_Version__c versionWithMappings(
        Id formId,
        Decimal numberValue
    ) {
        Form_Version__c version = new Form_Version__c(
            Form__c = formId,
            Version_Number__c = numberValue
        );
        insert version;
        Question__c count = question(version.Id, 'count', 'integer');
        insert count;
        Question__c repeat = question(version.Id, 'items', 'repeat');
        repeat.Repeat_Mode__c = 'from_answer';
        repeat.Repeat_Source_Question__c = count.Id;
        insert repeat;
        Question__c answer = question(version.Id, 'answer', 'text');
        answer.Parent__c = repeat.Id;
        insert answer;
        insert new Skip_Rule__c(
            Question__c = answer.Id,
            Source_Question__c = count.Id,
            Operator__c = 'greater_than',
            Value__c = '0'
        );
        Mapping__c reference = mapping(
            version.Id,
            'Synthetic Account reference'
        );
        reference.Kind__c = 'reference';
        reference.Matching_Field__c = 'Name';
        insert reference;
        Mapping__c child = mapping(version.Id, 'Synthetic child target');
        child.Kind__c = 'repeat';
        child.Repeat_Question__c = repeat.Id;
        child.Parent_Mapping__c = reference.Id;
        child.Parent_Lookup_Field__c = 'Account__c';
        child.Target_Object__c = 'Observation__c';
        insert child;
        insert new Field_Mapping__c(
            Mapping__c = child.Id,
            Question__c = answer.Id,
            Source_Kind__c = 'question',
            Target_Field__c = 'Observation__c',
            Transform__c = 'none'
        );
        return version;
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

    private static void addInlineBlocker(Id versionId) {
        Question__c owner = question(versionId, 'inline_owner', 'select_one');
        insert owner;
        insert new Choice_List__c(
            Name = 'Synthetic retained inline mapping list',
            Owner_Question__c = owner.Id
        );
    }

    private static Mapping__c savedRepeatMapping(Id versionId) {
        return [
            SELECT Id, Form_Version__c, Parent_Mapping__c, Repeat_Question__c
            FROM Mapping__c
            WHERE Form_Version__c = :versionId AND Kind__c = 'repeat'
        ];
    }

    private static Field_Mapping__c savedFieldMapping(Id versionId) {
        return [
            SELECT Id, Mapping__c, Question__c
            FROM Field_Mapping__c
            WHERE Mapping__r.Form_Version__c = :versionId
        ];
    }

    private static void assertOnlyBlockedDefinitionsRemain(
        Id versionId,
        Mapping__c originalMapping,
        Field_Mapping__c originalFieldMapping
    ) {
        // Native inline-list Restrict blocks this owner before its cleanup. The
        // successful independent cascade must not clear the failed owner's links.
        Assert.areEqual(1, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Form_Version__c WHERE Id = :versionId]
        );
        Assert.areEqual(4, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(
            4,
            [SELECT COUNT() FROM Question__c WHERE Form_Version__c = :versionId]
        );
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Choice_List__c]);
        Assert.areEqual(2, [SELECT COUNT() FROM Mapping__c]);
        Assert.areEqual(
            2,
            [SELECT COUNT() FROM Mapping__c WHERE Form_Version__c = :versionId]
        );
        Assert.areEqual(1, [SELECT COUNT() FROM Field_Mapping__c]);
        Mapping__c remainingMapping = savedRepeatMapping(versionId);
        Field_Mapping__c remainingFieldMapping = savedFieldMapping(versionId);
        Assert.areEqual(originalMapping.Id, remainingMapping.Id);
        Assert.areEqual(
            originalMapping.Parent_Mapping__c,
            remainingMapping.Parent_Mapping__c
        );
        Assert.areEqual(
            originalMapping.Repeat_Question__c,
            remainingMapping.Repeat_Question__c
        );
        Assert.areEqual(originalFieldMapping.Id, remainingFieldMapping.Id);
        Assert.areEqual(
            originalFieldMapping.Mapping__c,
            remainingFieldMapping.Mapping__c
        );
        Assert.areEqual(
            originalFieldMapping.Question__c,
            remainingFieldMapping.Question__c
        );
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
            Label__c = 'Synthetic mapping deletion question'
        );
        if (typeName == 'repeat') {
            definition.Repeat_Mode__c = 'open';
        }
        return definition;
    }

    private static void assertRejected(Database.DeleteResult result) {
        Assert.isFalse(result.isSuccess());
        Assert.areEqual(
            StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
            result.getErrors()[0].getStatusCode()
        );
    }

    private static void assertAllDeleted(List<Database.DeleteResult> results) {
        for (Database.DeleteResult result : results) {
            Assert.isTrue(result.isSuccess());
        }
    }
}
