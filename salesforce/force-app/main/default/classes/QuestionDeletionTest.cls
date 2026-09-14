/**
 * Responsibility: exercise direct question deletion and whole-form cascades with synthetic definitions.
 * Covers external self-reference protection, same-operation deletion and partial-DML retries.
 * Does not claim compilation, publication, collector behavior, or any brief C10 test.
 */
@IsTest
private class QuestionDeletionTest {
    @IsTest
    static void formDeletionCascadesMixedScopeAndSkipRules() {
        Form_Version__c version = createVersion('Synthetic cascade definition');
        Question__c section = question(version.Id, 'observation', 'section');
        insert section;
        Question__c count = question(version.Id, 'student_count', 'integer');
        count.Parent__c = section.Id;
        insert count;
        Question__c repeat = question(version.Id, 'students', 'repeat');
        repeat.Parent__c = section.Id;
        repeat.Repeat_Mode__c = 'from_answer';
        repeat.Repeat_Source_Question__c = count.Id;
        insert repeat;
        Question__c child = question(version.Id, 'student_observation', 'text');
        child.Parent__c = repeat.Id;
        insert child;
        Skip_Rule__c rule = new Skip_Rule__c(
            Question__c = child.Id,
            Source_Question__c = count.Id,
            Operator__c = 'greater_than',
            Value__c = '0'
        );
        insert rule;
        Assert.areEqual(4, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);

        // The Form trigger deletes only its owned skip rules first. Salesforce
        // then cascades details without firing their before-delete triggers.
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        delete new Form__c(Id = version.Form__c);
        Assert.areEqual(queriesBefore + 1, Limits.getQueries());
        Assert.areEqual(dmlBefore + 2, Limits.getDmlStatements());
        Assert.areEqual(0, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Skip_Rule__c]);
    }

    @IsTest
    static void parentRequiresEveryChildInTheSameDeleteOperation() {
        Form_Version__c version = createVersion('Synthetic parent deletion');
        Question__c parent = question(version.Id, 'section', 'section');
        insert parent;
        Question__c first = question(version.Id, 'first_child', 'text');
        first.Parent__c = parent.Id;
        Question__c second = question(version.Id, 'second_child', 'text');
        second.Parent__c = parent.Id;
        insert new List<Question__c>{ first, second };

        assertRejected(Database.delete(parent, false));
        Assert.areEqual(
            parent.Id,
            [SELECT Parent__c FROM Question__c WHERE Id = :first.Id].Parent__c
        );
        assertAllDeleted(
            Database.delete(
                new List<Question__c>{ parent, first, second },
                false
            )
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
    }

    @IsTest
    static void repeatSourceRequiresDependentRepeatInTheSameDeleteOperation() {
        Form_Version__c version = createVersion('Synthetic repeat deletion');
        Question__c count = question(version.Id, 'count', 'integer');
        insert count;
        Question__c repeat = question(version.Id, 'items', 'repeat');
        repeat.Repeat_Mode__c = 'from_answer';
        repeat.Repeat_Source_Question__c = count.Id;
        insert repeat;

        assertRejected(Database.delete(count, false));
        Assert.areEqual(
            count.Id,
            [
                SELECT Repeat_Source_Question__c
                FROM Question__c
                WHERE Id = :repeat.Id
            ]
            .Repeat_Source_Question__c
        );
        assertAllDeleted(
            Database.delete(new List<Question__c>{ count, repeat }, false)
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
    }

    @IsTest
    static void predecessorRequiresSuccessorInTheSameDeleteOperation() {
        Form_Version__c firstVersion = createVersion(
            'Synthetic lineage deletion'
        );
        Form_Version__c nextVersion = new Form_Version__c(
            Form__c = firstVersion.Form__c,
            Version_Number__c = 2
        );
        insert nextVersion;
        Question__c previous = question(firstVersion.Id, 'question', 'text');
        insert previous;
        Question__c current = question(nextVersion.Id, 'question', 'text');
        current.Previous_Version_Question__c = previous.Id;
        insert current;

        assertRejected(Database.delete(previous, false));
        Assert.areEqual(
            previous.Id,
            [
                SELECT Previous_Version_Question__c
                FROM Question__c
                WHERE Id = :current.Id
            ]
            .Previous_Version_Question__c
        );
        assertAllDeleted(
            Database.delete(new List<Question__c>{ previous, current }, false)
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(2, [SELECT COUNT() FROM Form_Version__c]);
    }

    @IsTest
    static void outsideDependantRejectsEntirePartialDeleteBatch() {
        Form_Version__c version = createVersion('Synthetic mixed delete batch');
        Question__c parent = question(version.Id, 'section', 'section');
        Question__c independent = question(version.Id, 'independent', 'text');
        insert new List<Question__c>{ parent, independent };
        Question__c outside = question(version.Id, 'outside_child', 'text');
        outside.Parent__c = parent.Id;
        insert outside;

        // Rejecting the whole input avoids allowing a row to rely on a dependant
        // whose deletion this invocation cannot guarantee, even under partial DML.
        List<Database.DeleteResult> results = Database.delete(
            new List<Question__c>{ parent, independent },
            false
        );
        Assert.areEqual(2, results.size());
        for (Database.DeleteResult result : results) {
            assertRejected(result);
        }
        Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(
            parent.Id,
            [SELECT Parent__c FROM Question__c WHERE Id = :outside.Id].Parent__c
        );
    }

    @IsTest
    static void partialDeleteRetryCannotOrphanAChildBlockedByAnotherRelationship() {
        Form_Version__c version = createVersion(
            'Synthetic partial retry deletion'
        );
        Question__c parent = question(version.Id, 'section', 'section');
        Question__c externalTarget = question(
            version.Id,
            'external_target',
            'text'
        );
        insert new List<Question__c>{ parent, externalTarget };
        Question__c child = question(version.Id, 'child', 'integer');
        child.Parent__c = parent.Id;
        insert child;
        Skip_Rule__c externalRule = new Skip_Rule__c(
            Question__c = externalTarget.Id,
            Source_Question__c = child.Id
        );
        insert externalRule;

        // Both self-reference ends initially belong to the delete operation, but
        // Source_Question's native Restrict prevents deleting the child. If the
        // platform retries the parent as a partial success, the remaining child
        // is external to that retry and the guard must reject the parent too.
        List<Database.DeleteResult> results = Database.delete(
            new List<Question__c>{ parent, child },
            false
        );
        Assert.areEqual(2, results.size());
        for (Database.DeleteResult result : results) {
            Assert.isFalse(result.isSuccess());
        }
        Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(
            parent.Id,
            [SELECT Parent__c FROM Question__c WHERE Id = :child.Id].Parent__c
        );
        Assert.areEqual(
            child.Id,
            [
                SELECT Source_Question__c
                FROM Skip_Rule__c
                WHERE Id = :externalRule.Id
            ]
            .Source_Question__c
        );
    }

    @IsTest
    static void bulkDeletionUsesOneQueryAndNoInternalDml() {
        Form_Version__c version = createVersion('Synthetic bulk deletion');
        List<Question__c> definitions = new List<Question__c>();
        for (Integer index = 0; index < 200; index++) {
            definitions.add(
                question(version.Id, 'section_' + index, 'section')
            );
        }
        insert definitions;
        for (Integer index = 1; index < definitions.size(); index++) {
            definitions[index].Parent__c = definitions[index - 1].Id;
        }
        update definitions;

        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        List<Database.DeleteResult> results = Database.delete(
            definitions,
            false
        );
        Assert.areEqual(queriesBefore + 1, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
        Assert.areEqual(200, results.size());
        assertAllDeleted(results);
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
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
        String typeName
    ) {
        Question__c definition = new Question__c(
            Form_Version__c = versionId,
            Name = name,
            Type__c = typeName,
            Order__c = 1,
            Label__c = 'Synthetic deletion question'
        );
        if (typeName == 'repeat') {
            definition.Repeat_Mode__c = 'open';
        }
        return definition;
    }

    private static void assertRejected(Database.DeleteResult result) {
        Assert.isFalse(
            result.isSuccess(),
            'Referenced question must remain stored'
        );
        Assert.areEqual(
            StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
            result.getErrors()[0].getStatusCode()
        );
    }

    private static void assertAllDeleted(List<Database.DeleteResult> results) {
        for (Database.DeleteResult result : results) {
            Assert.isTrue(
                result.isSuccess(),
                'Entire self-referencing delete set must succeed'
            );
        }
    }
}
