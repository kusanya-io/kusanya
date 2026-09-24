/**
 * Responsibility: test target-owned skip cleanup, rollback and bulk owner deletion.
 * Synthetic records only; no publishing, permissions or C10 behavior is claimed.
 */
@IsTest
private class DefinitionDeletionTest {
    @IsTest
    static void directVersionDeletionPreservesSiblingRules() {
        Form__c form = new Form__c(Name = 'Synthetic sibling versions');
        insert form;
        Form_Version__c first = versionWithRule(form.Id, 1);
        Form_Version__c sibling = versionWithRule(form.Id, 2);
        Id siblingRule = [
            SELECT Id
            FROM Skip_Rule__c
            WHERE Question__r.Form_Version__c = :sibling.Id
        ]
        .Id;
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        delete first;
        Assert.areEqual(queriesBefore + 2, Limits.getQueries());
        Assert.areEqual(dmlBefore + 2, Limits.getDmlStatements());
        Assert.areEqual(1, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(2, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Skip_Rule__c WHERE Id = :siblingRule]
        );
    }

    @IsTest
    static void nativeRestrictionPreservesRulesBeforeCleanup() {
        Form__c form = new Form__c(Name = 'Synthetic blocked form');
        insert form;
        Form_Version__c version = versionWithRule(form.Id, 1);
        addInlineBlocker(version.Id);
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        Database.DeleteResult result = Database.delete(form, false);
        Assert.isFalse(result.isSuccess());
        Assert.areEqual(
            StatusCode.DELETE_FAILED,
            result.getErrors()[0].getStatusCode()
        );
        // This native restriction runs before the owner trigger, not after
        // cleanup. Do not mislabel this preservation check as executed rollback.
        Assert.areEqual(queriesBefore, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
        Assert.areEqual(1, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Choice_List__c]);
    }

    @IsTest
    static void outerRollbackRestoresExecutedOwnerAndRuleDeletion() {
        Form__c form = new Form__c(Name = 'Synthetic rollback form');
        insert form;
        Form_Version__c version = versionWithRule(form.Id, 1);
        Savepoint checkpoint = Database.setSavepoint();
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        delete form;
        Assert.areEqual(queriesBefore + 3, Limits.getQueries());
        Assert.areEqual(dmlBefore + 2, Limits.getDmlStatements());
        Assert.areEqual(0, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Skip_Rule__c]);
        Database.rollback(checkpoint);
        Assert.areEqual(1, [SELECT COUNT() FROM Form__c WHERE Id = :form.Id]);
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Form_Version__c WHERE Id = :version.Id]
        );
        Assert.areEqual(2, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(
            1,
            [
                SELECT COUNT()
                FROM Skip_Rule__c
                WHERE Question__r.Form_Version__c = :version.Id
            ]
        );
    }

    @IsTest
    static void partialFormDeletionKeepsFailedOwnersRule() {
        Form__c blocked = new Form__c(Name = 'Synthetic blocked partial form');
        Form__c clean = new Form__c(Name = 'Synthetic clean partial form');
        insert new List<Form__c>{ blocked, clean };
        Form_Version__c blockedVersion = versionWithRule(blocked.Id, 1);
        versionWithRule(clean.Id, 1);
        addInlineBlocker(blockedVersion.Id);
        List<Database.DeleteResult> results = Database.delete(
            new List<Form__c>{ blocked, clean },
            false
        );
        Assert.isFalse(results[0].isSuccess());
        Assert.isTrue(results[1].isSuccess());
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Form__c WHERE Id = :blocked.Id]
        );
        Assert.areEqual(0, [SELECT COUNT() FROM Form__c WHERE Id = :clean.Id]);
        assertOnlyBlockedVersionRemains(blockedVersion.Id);
    }

    @IsTest
    static void partialVersionDeletionKeepsFailedOwnersRule() {
        Form__c form = new Form__c(Name = 'Synthetic partial versions');
        insert form;
        Form_Version__c blocked = versionWithRule(form.Id, 1);
        Form_Version__c clean = versionWithRule(form.Id, 2);
        addInlineBlocker(blocked.Id);
        List<Database.DeleteResult> results = Database.delete(
            new List<Form_Version__c>{ blocked, clean },
            false
        );
        Assert.isFalse(results[0].isSuccess());
        Assert.isTrue(results[1].isSuccess());
        Assert.areEqual(1, [SELECT COUNT() FROM Form__c]);
        assertOnlyBlockedVersionRemains(blocked.Id);
    }

    @IsTest
    static void bulkFormsDeleteUsesOneQueryAndOneChildDml() {
        List<Form__c> forms = new List<Form__c>();
        for (Integer index = 0; index < 200; index++) {
            forms.add(new Form__c(Name = 'Synthetic bulk form ' + index));
        }
        insert forms;
        List<Form_Version__c> versions = new List<Form_Version__c>();
        for (Form__c form : forms) {
            versions.add(
                new Form_Version__c(Form__c = form.Id, Version_Number__c = 1)
            );
        }
        insert versions;
        List<Question__c> questions = new List<Question__c>();
        for (Form_Version__c version : versions) {
            questions.add(question(version.Id, 'source', 'integer'));
            questions.add(question(version.Id, 'target', 'text'));
        }
        insert questions;
        List<Skip_Rule__c> rules = new List<Skip_Rule__c>();
        for (Integer index = 0; index < questions.size(); index += 2) {
            rules.add(
                new Skip_Rule__c(
                    Source_Question__c = questions[index].Id,
                    Question__c = questions[index + 1].Id
                )
            );
        }
        insert rules;
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        delete forms;
        Assert.areEqual(queriesBefore + 3, Limits.getQueries());
        Assert.areEqual(dmlBefore + 2, Limits.getDmlStatements());
        Assert.areEqual(0, [SELECT COUNT() FROM Form__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Skip_Rule__c]);
    }

    private static Form_Version__c versionWithRule(
        Id formId,
        Integer numberValue
    ) {
        Form_Version__c version = new Form_Version__c(
            Form__c = formId,
            Version_Number__c = numberValue
        );
        insert version;
        Question__c source = question(version.Id, 'source', 'integer');
        Question__c target = question(version.Id, 'target', 'text');
        insert new List<Question__c>{ source, target };
        insert new Skip_Rule__c(
            Question__c = target.Id,
            Source_Question__c = source.Id
        );
        return version;
    }

    private static void addInlineBlocker(Id versionId) {
        Question__c owner = question(versionId, 'inline_owner', 'select_one');
        insert owner;
        insert new Choice_List__c(
            Name = 'Synthetic retained inline list',
            Owner_Question__c = owner.Id
        );
    }

    private static Question__c question(
        Id versionId,
        String name,
        String typeName
    ) {
        return new Question__c(
            Form_Version__c = versionId,
            Name = name,
            Type__c = typeName,
            Order__c = 1,
            Label__c = 'Synthetic cascade question'
        );
    }

    private static void assertOnlyBlockedVersionRemains(Id blockedVersionId) {
        Assert.areEqual(1, [SELECT COUNT() FROM Form_Version__c]);
        Assert.areEqual(3, [SELECT COUNT() FROM Question__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Choice_List__c]);
        Assert.areEqual(1, [SELECT COUNT() FROM Skip_Rule__c]);
        Assert.areEqual(
            1,
            [
                SELECT COUNT()
                FROM Skip_Rule__c
                WHERE Question__r.Form_Version__c = :blockedVersionId
            ]
        );
    }
}
