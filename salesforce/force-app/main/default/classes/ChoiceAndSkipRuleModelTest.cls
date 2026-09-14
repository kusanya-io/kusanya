/**
 * Responsibility: exercise reusable/inline choices and skip-rule references using synthetic definitions.
 * Does not compile XPath, exercise collector delivery, or claim C10 acceptance tests.
 */
@IsTest
private class ChoiceAndSkipRuleModelTest {
    @IsTest
    static void reusableListsHaveDistinctValuesAndDescriptiveLabels() {
        Choice_List__c first = new Choice_List__c(Name = 'Synthetic choices');
        Choice_List__c second = new Choice_List__c(
            Name = 'Synthetic second choices'
        );
        insert new List<Choice_List__c>{ first, second };
        List<Choice__c> choices = new List<Choice__c>{
            choice(first.Id, 'yes', 1),
            choice(first.Id, 'Yes', 2),
            choice(second.Id, 'yes', 1)
        };
        choices[0].Label__c = 'Yes, supplies are present';
        choices[0].Filter_Value__c = 'synthetic_filter';
        choices[0].Score__c = 2.5;
        insert choices;
        Id choiceId = choices[0].Id;
        Choice__c saved = [
            SELECT
                Value__c,
                Label__c,
                Filter_Value__c,
                Score__c,
                Choice_Key__c,
                Choice_List__r.Name
            FROM Choice__c
            WHERE Id = :choiceId
        ];
        Assert.areEqual('yes', saved.Value__c);
        Assert.areEqual('Yes, supplies are present', saved.Label__c);
        Assert.areEqual('synthetic_filter', saved.Filter_Value__c);
        Assert.areEqual(2.5, saved.Score__c);
        Assert.areEqual('Synthetic choices', saved.Choice_List__r.Name);
        Assert.areEqual(64, saved.Choice_Key__c.length());
        Database.SaveResult duplicate = Database.insert(
            choice(first.Id, 'yes', 3),
            false
        );
        Assert.isFalse(duplicate.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicate.getErrors()[0].getStatusCode()
        );
        choices[1].Value__c = 'yes';
        Database.SaveResult duplicateUpdate = Database.update(
            choices[1],
            false
        );
        Assert.isFalse(duplicateUpdate.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicateUpdate.getErrors()[0].getStatusCode()
        );
    }

    @IsTest
    static void choiceKeysAreBulkSafeAndCannotBeSuppliedByCallers() {
        Choice_List__c listRecord = new Choice_List__c(
            Name = 'Synthetic bulk choices'
        );
        insert listRecord;
        List<Choice__c> choices = new List<Choice__c>();
        for (Integer index = 1; index <= 200; index++) {
            Choice__c entry = choice(listRecord.Id, 'value_' + index, index);
            entry.Choice_Key__c = 'untrusted-key';
            choices.add(entry);
        }
        Integer queryCount = Limits.getQueries();
        Integer dmlCount = Limits.getDmlStatements();
        insert choices;
        Assert.areEqual(queryCount, Limits.getQueries());
        Assert.areEqual(dmlCount + 1, Limits.getDmlStatements());
        List<Choice__c> saved = [
            SELECT Choice_Key__c
            FROM Choice__c
            WHERE Choice_List__c = :listRecord.Id
        ];
        Set<String> keys = new Set<String>();
        for (Choice__c entry : saved)
            keys.add(entry.Choice_Key__c);
        Assert.areEqual(200, keys.size());
        Assert.isFalse(keys.contains('untrusted-key'));
        choices[0].Value__c = 'updated_value';
        choices[0].Choice_Key__c = 'replacement-key';
        update choices[0];
        Id changedId = choices[0].Id;
        String changedKey = [
            SELECT Choice_Key__c
            FROM Choice__c
            WHERE Id = :changedId
        ]
        .Choice_Key__c;
        Assert.isFalse(keys.contains(changedKey));
        Assert.areEqual(64, changedKey.length());
    }

    @IsTest
    static void choiceRequiredContentAndPositiveOrderingAreValidated() {
        Choice_List__c listRecord = new Choice_List__c(
            Name = 'Synthetic invalid choices'
        );
        insert listRecord;
        List<Choice__c> invalid = new List<Choice__c>{
            choice(listRecord.Id, 'zero', 0),
            choice(listRecord.Id, 'fraction', 1.5),
            choice(listRecord.Id, 'negative', -1),
            choice(listRecord.Id, 'blank_label', 1),
            choice(listRecord.Id, null, 2),
            choice(null, 'no_list', 3)
        };
        invalid[3].Label__c = '   ';
        List<Database.SaveResult> results = Database.insert(invalid, false);
        for (Database.SaveResult result : results)
            Assert.isFalse(result.isSuccess());
        Assert.areEqual(0, [SELECT COUNT() FROM Choice__c]);
    }

    @IsTest
    static void inlineOwnershipIsSelectedAtCreationAndCannotBeReassigned() {
        Form_Version__c version = formVersion('Synthetic inline definition');
        Question__c selector = question(version.Id, 'selector', 'select_one');
        Question__c otherSelector = question(
            version.Id,
            'other_selector',
            'select_multiple'
        );
        Question__c textQuestion = question(version.Id, 'plain_text', 'text');
        insert new List<Question__c>{ selector, otherSelector, textQuestion };
        Choice_List__c inlineList = new Choice_List__c(
            Name = 'Synthetic inline',
            Owner_Question__c = selector.Id
        );
        insert inlineList;
        selector.Choice_List__c = inlineList.Id;
        update selector;
        inlineList.Description__c = 'Updated synthetic description';
        update inlineList;
        inlineList.Owner_Question__c = otherSelector.Id;
        Database.SaveResult changedOwner = Database.update(inlineList, false);
        Assert.isFalse(changedOwner.isSuccess());
        Assert.isTrue(
            changedOwner.getErrors()[0]
                .getMessage()
                .contains('ownership cannot change')
        );
        Database.SaveResult invalidOwner = Database.insert(
            new Choice_List__c(
                Name = 'Synthetic invalid owner',
                Owner_Question__c = textQuestion.Id
            ),
            false
        );
        Assert.isFalse(invalidOwner.isSuccess());
        Assert.isTrue(
            invalidOwner.getErrors()[0].getMessage().contains('select question')
        );
        otherSelector.Choice_List__c = inlineList.Id;
        Assert.isFalse(Database.update(otherSelector, false).isSuccess());
        selector.Type__c = 'text';
        selector.Choice_List__c = null;
        Assert.isFalse(Database.update(selector, false).isSuccess());
    }

    @IsTest
    static void unreferencedListsCascadeChoicesButReferencedListsAreProtected() {
        Choice_List__c disposable = new Choice_List__c(
            Name = 'Synthetic disposable list'
        );
        insert disposable;
        Choice__c child = choice(disposable.Id, 'one', 1);
        insert child;
        delete disposable;
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Choice__c WHERE Id = :child.Id]
        );
        Form_Version__c version = formVersion('Synthetic referenced list');
        Choice_List__c referenced = new Choice_List__c(
            Name = 'Synthetic referenced choices'
        );
        insert referenced;
        Question__c selector = question(version.Id, 'site_type', 'select_one');
        selector.Choice_List__c = referenced.Id;
        insert selector;
        Assert.isFalse(Database.delete(referenced, false).isSuccess());
    }

    @IsTest
    static void skipRulesPersistAuthoringValuesAndUseOneVersion() {
        Form_Version__c version = formVersion('Synthetic skip definition');
        Question__c source = question(version.Id, 'has_supplies', 'integer');
        Question__c target = question(version.Id, 'supply_description', 'text');
        insert new List<Question__c>{ source, target };
        Skip_Rule__c rule = new Skip_Rule__c(
            Question__c = target.Id,
            Source_Question__c = source.Id,
            Operator__c = 'in_range',
            Value__c = '1',
            Value_To__c = '10',
            Join__c = 'all',
            Action__c = 'show'
        );
        insert rule;
        Skip_Rule__c saved = [
            SELECT
                Question__r.Name,
                Source_Question__r.Name,
                Operator__c,
                Value__c,
                Value_To__c,
                Join__c,
                Action__c
            FROM Skip_Rule__c
            WHERE Id = :rule.Id
        ];
        Assert.areEqual('has_supplies', saved.Source_Question__r.Name);
        Assert.areEqual('supply_description', saved.Question__r.Name);
        Assert.areEqual('in_range', saved.Operator__c);
        Assert.areEqual('1', saved.Value__c);
        Assert.areEqual('10', saved.Value_To__c);
        Assert.areEqual('all', saved.Join__c);
        Assert.areEqual('show', saved.Action__c);
        rule.Value_To__c = '20';
        update rule;
        Assert.areEqual(
            '20',
            [SELECT Value_To__c FROM Skip_Rule__c WHERE Id = :rule.Id]
            .Value_To__c
        );
        delete target;
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Skip_Rule__c WHERE Id = :rule.Id]
        );
    }

    @IsTest
    static void skipRulesRejectCrossVersionSelfAndMissingReferencesOnBothWrites() {
        Form_Version__c first = formVersion('Synthetic first rule version');
        Form_Version__c second = formVersion('Synthetic second rule version');
        Question__c a = question(first.Id, 'first', 'text');
        Question__c b = question(first.Id, 'second', 'text');
        Question__c foreignQuestion = question(
            second.Id,
            'foreign_question',
            'text'
        );
        insert new List<Question__c>{ a, b, foreignQuestion };
        List<Skip_Rule__c> invalid = new List<Skip_Rule__c>{
            new Skip_Rule__c(
                Question__c = a.Id,
                Source_Question__c = foreignQuestion.Id
            ),
            new Skip_Rule__c(Question__c = a.Id, Source_Question__c = a.Id),
            new Skip_Rule__c(Question__c = a.Id),
            new Skip_Rule__c(Source_Question__c = b.Id)
        };
        for (Database.SaveResult result : Database.insert(invalid, false))
            Assert.isFalse(result.isSuccess());
        Skip_Rule__c valid = new Skip_Rule__c(
            Question__c = a.Id,
            Source_Question__c = b.Id
        );
        insert valid;
        valid.Source_Question__c = foreignQuestion.Id;
        Assert.isFalse(Database.update(valid, false).isSuccess());
        Assert.isFalse(Database.delete(b, false).isSuccess());
    }

    @IsTest
    static void bulkSkipRulesHaveBoundedQueriesAndNoNestedDml() {
        Form_Version__c version = formVersion('Synthetic bulk rules');
        Question__c a = question(version.Id, 'source', 'integer');
        Question__c b = question(version.Id, 'target', 'text');
        insert new List<Question__c>{ a, b };
        List<Skip_Rule__c> rules = new List<Skip_Rule__c>();
        for (Integer index = 0; index < 200; index++) {
            rules.add(
                new Skip_Rule__c(
                    Question__c = b.Id,
                    Source_Question__c = a.Id,
                    Operator__c = 'is',
                    Value__c = String.valueOf(index)
                )
            );
        }
        Integer queries = Limits.getQueries();
        Integer dml = Limits.getDmlStatements();
        insert rules;
        Assert.areEqual(queries + 1, Limits.getQueries());
        Assert.areEqual(dml + 1, Limits.getDmlStatements());
        Assert.areEqual(200, [SELECT COUNT() FROM Skip_Rule__c]);
    }

    @IsTest
    static void skipOperatorOperandsAreCheckedOnInsertAndUpdate() {
        Form_Version__c version = formVersion('Synthetic operator shapes');
        Question__c source = question(version.Id, 'source', 'text');
        Question__c target = question(version.Id, 'target', 'text');
        insert new List<Question__c>{ source, target };
        List<Skip_Rule__c> valid = new List<Skip_Rule__c>();
        for (
            String operatorName : new List<String>{
                'answered',
                'is',
                'is_not',
                'less_than',
                'greater_than',
                'in_range',
                'contains'
            }
        ) {
            valid.add(
                new Skip_Rule__c(
                    Question__c = target.Id,
                    Source_Question__c = source.Id,
                    Operator__c = operatorName,
                    Value__c = operatorName == 'answered' ? null : '1',
                    Value_To__c = operatorName == 'in_range' ? '10' : null
                )
            );
        }
        insert valid;
        List<Skip_Rule__c> invalid = new List<Skip_Rule__c>{
            new Skip_Rule__c(
                Question__c = target.Id,
                Source_Question__c = source.Id,
                Operator__c = 'answered',
                Value__c = 'unexpected'
            ),
            new Skip_Rule__c(
                Question__c = target.Id,
                Source_Question__c = source.Id,
                Operator__c = 'answered',
                Value_To__c = 'unexpected'
            ),
            new Skip_Rule__c(
                Question__c = target.Id,
                Source_Question__c = source.Id,
                Operator__c = 'is',
                Value__c = '   '
            ),
            new Skip_Rule__c(
                Question__c = target.Id,
                Source_Question__c = source.Id,
                Operator__c = 'in_range',
                Value__c = '1'
            ),
            new Skip_Rule__c(
                Question__c = target.Id,
                Source_Question__c = source.Id,
                Operator__c = 'contains',
                Value__c = 'word',
                Value_To__c = 'extra'
            )
        };
        for (Database.SaveResult result : Database.insert(invalid, false)) {
            Assert.isFalse(result.isSuccess());
        }
        valid[0].Value__c = 'unexpected';
        valid[1].Value__c = null;
        valid[5].Value_To__c = null;
        for (
            Database.SaveResult result : Database.update(
                new List<Skip_Rule__c>{ valid[0], valid[1], valid[5] },
                false
            )
        ) {
            Assert.isFalse(result.isSuccess());
        }
        Assert.areEqual(7, [SELECT COUNT() FROM Skip_Rule__c]);
    }

    @IsTest
    static void inlineOwnerCannotBeClearedAndDeletionUsesExplicitUnlinking() {
        Form_Version__c version = formVersion('Synthetic inline deletion');
        Question__c selector = question(version.Id, 'selector', 'select_one');
        insert selector;
        Choice_List__c inlineList = new Choice_List__c(
            Name = 'Synthetic inline cleanup',
            Owner_Question__c = selector.Id
        );
        insert inlineList;
        insert choice(inlineList.Id, 'one', 1);
        selector.Choice_List__c = inlineList.Id;
        update selector;
        Assert.isFalse(Database.delete(selector, false).isSuccess());
        inlineList.Owner_Question__c = null;
        Assert.isFalse(Database.update(inlineList, false).isSuccess());
        selector.Choice_List__c = null;
        update selector;
        delete inlineList;
        delete selector;
        Assert.areEqual(0, [SELECT COUNT() FROM Choice_List__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Choice__c]);
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
    }

    private static Choice__c choice(
        Id listId,
        String value,
        Decimal orderNumber
    ) {
        return new Choice__c(
            Choice_List__c = listId,
            Value__c = value,
            Label__c = 'Synthetic label',
            Order__c = orderNumber
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
            Order__c = 1
        );
    }
    private static Form_Version__c formVersion(String name) {
        Form__c form = new Form__c(Name = name);
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        return version;
    }
}
