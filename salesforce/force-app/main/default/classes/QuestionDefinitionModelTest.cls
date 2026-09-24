/**
 * Responsibility: verify question identity and tree invariants using synthetic definitions.
 * Covers mixed once-only/repeat scope and independent author notes, not collector output.
 * Does not claim compilation, publication, effective sharing, or any brief C10 test.
 */
@IsTest
private class QuestionDefinitionModelTest {
    @IsTest
    static void storesOnceOnlyAndRepeatedChildrenInDistinctScopes() {
        Form_Version__c version = createVersion('Synthetic mixed scope', 1);
        Question__c section = question(version.Id, 'observation', 'section', 1);
        insert section;
        Question__c station = question(version.Id, 'station_ready', 'text', 1);
        station.Parent__c = section.Id;
        station.Hint__c = 'Collector-facing synthetic help';
        station.Author_Notes__c = 'Author-only synthetic review note';
        Question__c count = question(version.Id, 'student_count', 'integer', 2);
        count.Parent__c = section.Id;
        insert new List<Question__c>{ station, count };
        Question__c students = question(version.Id, 'students', 'repeat', 3);
        students.Parent__c = section.Id;
        students.Repeat_Mode__c = 'from_answer';
        students.Repeat_Source_Question__c = count.Id;
        students.Repeat_Max__c = 40;
        Question__c closing = question(version.Id, 'closing_note', 'note', 4);
        closing.Parent__c = section.Id;
        insert new List<Question__c>{ students, closing };
        Question__c student = question(
            version.Id,
            'student_observation',
            'text',
            1
        );
        student.Parent__c = students.Id;
        insert student;
        Map<Id, Question__c> saved = new Map<Id, Question__c>(
            [
                SELECT
                    Parent__c,
                    Parent__r.Type__c,
                    Hint__c,
                    Author_Notes__c,
                    Repeat_Source_Question__c,
                    Repeat_Max__c
                FROM Question__c
                WHERE Form_Version__c = :version.Id
            ]
        );
        Assert.areEqual(6, saved.size());
        Assert.areEqual(section.Id, saved.get(station.Id).Parent__c);
        Assert.areEqual(section.Id, saved.get(closing.Id).Parent__c);
        Assert.areEqual(students.Id, saved.get(student.Id).Parent__c);
        Assert.areEqual('repeat', saved.get(student.Id).Parent__r.Type__c);
        Assert.areEqual(
            count.Id,
            saved.get(students.Id).Repeat_Source_Question__c
        );
        Assert.areEqual(40, saved.get(students.Id).Repeat_Max__c);
        Assert.areEqual(
            'Collector-facing synthetic help',
            saved.get(station.Id).Hint__c
        );
        Assert.areEqual(
            'Author-only synthetic review note',
            saved.get(station.Id).Author_Notes__c
        );
    }

    @IsTest
    static void namesAreUniquePerVersionAndKeysCannotBeOverridden() {
        Form_Version__c first = createVersion('Synthetic name identity', 1);
        Form_Version__c second = new Form_Version__c(
            Form__c = first.Form__c,
            Version_Number__c = 2
        );
        insert second;
        Question__c original = question(first.Id, 'same_name', 'text', 1);
        original.Question_Key__c = 'caller-key';
        Question__c anotherVersion = question(
            second.Id,
            'same_name',
            'text',
            1
        );
        insert new List<Question__c>{ original, anotherVersion };
        insert question(first.Id, 'Same_Name', 'text', 4);
        Assert.areEqual(
            String.valueOf(first.Id) + ':same_name',
            [SELECT Question_Key__c FROM Question__c WHERE Id = :original.Id]
            .Question_Key__c
        );
        Database.SaveResult duplicate = Database.insert(
            question(first.Id, 'same_name', 'text', 2),
            false
        );
        Assert.isFalse(duplicate.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicate.getErrors()[0].getStatusCode()
        );
        Question__c renamed = question(first.Id, 'other_name', 'text', 3);
        insert renamed;
        renamed.Name = 'same_name';
        Assert.isFalse(Database.update(renamed, false).isSuccess());
        original.Name = '_valid.name-2';
        original.Question_Key__c = 'replacement-key';
        update original;
        Assert.areEqual(
            String.valueOf(first.Id) + ':_valid.name-2',
            [SELECT Question_Key__c FROM Question__c WHERE Id = :original.Id]
            .Question_Key__c
        );
    }

    @IsTest
    static void rejectsInvalidPortableNodeNames() {
        Form_Version__c version = createVersion('Synthetic node validation', 1);
        List<Question__c> invalid = new List<Question__c>();
        for (
            String name : new List<String>{
                '1name',
                'two words',
                'with:prefix',
                'with/slash',
                'xmlReserved',
                'XMLreserved',
                'field[1]',
                'bad<name'
            }
        ) {
            invalid.add(question(version.Id, name, 'text', 1));
        }
        assertAllRejected(Database.insert(invalid, false));
        Assert.areEqual(0, [SELECT COUNT() FROM Question__c]);
    }

    @IsTest
    static void bulkIdentityAndTreeChecksUseFixedQueriesWithoutOwnDml() {
        Form_Version__c version = createVersion(
            'Synthetic bulk definitions',
            1
        );
        List<Question__c> definitions = new List<Question__c>();
        for (Integer index = 0; index < 200; index++) {
            definitions.add(
                question(version.Id, 'item_' + index, 'text', index + 1)
            );
        }
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        insert definitions;
        Assert.areEqual(queriesBefore + 4, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
        List<Question__c> saved = [
            SELECT Name, Question_Key__c
            FROM Question__c
        ];
        Assert.areEqual(200, saved.size());
        for (Question__c definition : saved) {
            Assert.areEqual(
                String.valueOf(version.Id) + ':' + definition.Name,
                definition.Question_Key__c
            );
        }
        for (Question__c definition : definitions) {
            definition.Author_Notes__c = 'Synthetic bulk author edit';
        }
        queriesBefore = Limits.getQueries();
        dmlBefore = Limits.getDmlStatements();
        update definitions;
        Assert.areEqual(queriesBefore + 4, Limits.getQueries());
        Assert.areEqual(dmlBefore + 1, Limits.getDmlStatements());
    }

    @IsTest
    static void parentMustBeSameVersionContainerAndNotSelf() {
        Form_Version__c first = createVersion('Synthetic parent first', 1);
        Form_Version__c second = createVersion('Synthetic parent second', 1);
        Question__c text = question(first.Id, 'text_parent', 'text', 1);
        Question__c foreignSection = question(
            second.Id,
            'foreign_section',
            'section',
            1
        );
        Question__c self = question(first.Id, 'self_section', 'section', 2);
        insert new List<Question__c>{ text, foreignSection, self };
        Question__c notContainer = question(
            first.Id,
            'bad_parent_type',
            'text',
            3
        );
        notContainer.Parent__c = text.Id;
        Question__c crossVersion = question(
            first.Id,
            'bad_parent_version',
            'text',
            4
        );
        crossVersion.Parent__c = foreignSection.Id;
        assertAllRejected(
            Database.insert(
                new List<Question__c>{ notContainer, crossVersion },
                false
            )
        );
        self.Parent__c = self.Id;
        // Salesforce rejects a direct self-lookup before the custom guard.
        assertRejected(
            Database.update(self, false),
            StatusCode.CIRCULAR_DEPENDENCY
        );
        Assert.isNull(
            [SELECT Parent__c FROM Question__c WHERE Id = :self.Id].Parent__c
        );
    }

    @IsTest
    static void validatesDeepTreesIterativelyInOneBulkUpdate() {
        Form_Version__c version = createVersion('Synthetic deep tree', 1);
        List<Question__c> definitions = new List<Question__c>();
        for (Integer index = 0; index < 200; index++) {
            definitions.add(
                question(version.Id, 'section_' + index, 'section', index + 1)
            );
        }
        insert definitions;
        for (Integer index = 1; index < definitions.size(); index++) {
            definitions[index].Parent__c = definitions[index - 1].Id;
        }
        Integer queriesBefore = Limits.getQueries();
        update definitions;
        Assert.areEqual(queriesBefore + 4, Limits.getQueries());
        Assert.areEqual(
            199,
            [SELECT COUNT() FROM Question__c WHERE Parent__c != NULL]
        );
        definitions[0].Parent__c = definitions[199].Id;
        assertRejected(Database.update(definitions[0], false));
    }

    @IsTest
    static void rejectsExistingAncestorAndTwoRowBulkCycles() {
        Form_Version__c version = createVersion('Synthetic cycle checks', 1);
        Question__c first = question(version.Id, 'first_section', 'section', 1);
        Question__c second = question(
            version.Id,
            'second_section',
            'section',
            2
        );
        insert new List<Question__c>{ first, second };
        second.Parent__c = first.Id;
        update second;
        Question__c third = question(version.Id, 'third_section', 'section', 1);
        third.Parent__c = second.Id;
        insert third;
        first.Parent__c = third.Id;
        assertRejected(Database.update(first, false));
        first.Parent__c = null;
        second.Parent__c = null;
        update second;
        first.Parent__c = second.Id;
        second.Parent__c = first.Id;
        assertAllRejected(
            Database.update(new List<Question__c>{ first, second }, false)
        );
        Assert.isNull(
            [SELECT Parent__c FROM Question__c WHERE Id = :first.Id].Parent__c
        );
        Assert.isNull(
            [SELECT Parent__c FROM Question__c WHERE Id = :second.Id].Parent__c
        );
    }

    @IsTest
    static void edgeReversalRequiresStagingForPartialDmlSafety() {
        Form_Version__c version = createVersion('Synthetic partial tree', 1);
        Question__c first = question(version.Id, 'first', 'section', 1);
        insert first;
        Question__c second = question(version.Id, 'second', 'section', 1);
        second.Parent__c = first.Id;
        insert second;
        // The complete proposal is acyclic, but if detaching second failed a
        // later validation, applying first would create a persisted cycle.
        first.Parent__c = second.Id;
        second.Parent__c = null;
        assertAllRejected(
            Database.update(new List<Question__c>{ first, second }, false)
        );
        update second;
        update first;
        Assert.areEqual(
            second.Id,
            [SELECT Parent__c FROM Question__c WHERE Id = :first.Id].Parent__c
        );
    }

    @IsTest
    static void containerRoleChangeCannotDependOnAnotherRowSucceeding() {
        Form_Version__c version = createVersion('Synthetic parent role', 1);
        Question__c parent = question(version.Id, 'container', 'section', 1);
        insert parent;
        Question__c child = question(version.Id, 'child', 'text', 1);
        child.Parent__c = parent.Id;
        insert child;
        parent.Type__c = 'text';
        assertRejected(Database.update(parent, false));
        child.Parent__c = null;
        assertAllRejected(
            Database.update(new List<Question__c>{ parent, child }, false)
        );
        update child;
        update parent;
        Assert.areEqual(
            'text',
            [SELECT Type__c FROM Question__c WHERE Id = :parent.Id].Type__c
        );
    }

    @IsTest
    static void newlyPromotedContainerCannotBeRequiredBySameBatch() {
        Form_Version__c version = createVersion('Synthetic promoted parent', 1);
        Question__c parent = question(version.Id, 'parent', 'text', 1);
        Question__c child = question(version.Id, 'child', 'text', 2);
        insert new List<Question__c>{ parent, child };
        parent.Type__c = 'section';
        child.Parent__c = parent.Id;
        assertAllRejected(
            Database.update(new List<Question__c>{ parent, child }, false)
        );
        update parent;
        update child;
    }

    @IsTest
    static void validatesRepeatModesAndBoundsWithoutChangingMeaning() {
        Form_Version__c version = createVersion('Synthetic repeat modes', 1);
        Question__c fixed = question(version.Id, 'fixed_repeat', 'repeat', 1);
        fixed.Repeat_Mode__c = 'fixed';
        fixed.Repeat_Count__c = 5;
        fixed.Repeat_Max__c = 5;
        fixed.Repeat_As_Table__c = true;
        Question__c open = question(version.Id, 'open_repeat', 'repeat', 2);
        open.Repeat_Max__c = 8;
        insert new List<Question__c>{ fixed, open };
        List<Question__c> invalid = new List<Question__c>();
        Question__c missingMode = question(
            version.Id,
            'missing_mode',
            'repeat',
            3
        );
        missingMode.Repeat_Mode__c = null;
        invalid.add(missingMode);
        Question__c missingCount = question(
            version.Id,
            'missing_count',
            'repeat',
            4
        );
        missingCount.Repeat_Mode__c = 'fixed';
        invalid.add(missingCount);
        Question__c missingSource = question(
            version.Id,
            'missing_source',
            'repeat',
            5
        );
        missingSource.Repeat_Mode__c = 'from_answer';
        invalid.add(missingSource);
        Question__c lowMaximum = question(
            version.Id,
            'low_maximum',
            'repeat',
            6
        );
        lowMaximum.Repeat_Mode__c = 'fixed';
        lowMaximum.Repeat_Count__c = 5;
        lowMaximum.Repeat_Max__c = 4;
        invalid.add(lowMaximum);
        Question__c countOnOpen = question(
            version.Id,
            'count_on_open',
            'repeat',
            7
        );
        countOnOpen.Repeat_Count__c = 5;
        invalid.add(countOnOpen);
        Question__c modeOnText = question(
            version.Id,
            'mode_on_text',
            'text',
            8
        );
        modeOnText.Repeat_Mode__c = 'open';
        invalid.add(modeOnText);
        Question__c tableOnText = question(
            version.Id,
            'table_on_text',
            'text',
            9
        );
        tableOnText.Repeat_As_Table__c = true;
        invalid.add(tableOnText);
        Question__c boundOnText = question(
            version.Id,
            'bound_on_text',
            'text',
            10
        );
        boundOnText.Repeat_Max__c = 5;
        invalid.add(boundOnText);
        assertAllRejected(Database.insert(invalid, false));
    }

    @IsTest
    static void repeatSourcesMustBeIntegerInSameVersionAndNotSelf() {
        Form_Version__c first = createVersion('Synthetic source first', 1);
        Form_Version__c second = createVersion('Synthetic source second', 1);
        Question__c count = question(first.Id, 'count', 'integer', 1);
        Question__c wrongType = question(first.Id, 'wrong_type', 'text', 2);
        Question__c foreign = question(
            second.Id,
            'foreign_count',
            'integer',
            1
        );
        Question__c repeat = question(first.Id, 'repeat', 'repeat', 3);
        insert new List<Question__c>{ count, wrongType, foreign, repeat };
        repeat.Repeat_Mode__c = 'from_answer';
        repeat.Repeat_Source_Question__c = wrongType.Id;
        assertRejected(Database.update(repeat, false));
        repeat.Repeat_Source_Question__c = foreign.Id;
        assertRejected(Database.update(repeat, false));
        repeat.Repeat_Source_Question__c = repeat.Id;
        assertRejected(
            Database.update(repeat, false),
            StatusCode.CIRCULAR_DEPENDENCY
        );
        Question__c unchangedRepeat = [
            SELECT Repeat_Mode__c, Repeat_Source_Question__c
            FROM Question__c
            WHERE Id = :repeat.Id
        ];
        Assert.areEqual('open', unchangedRepeat.Repeat_Mode__c);
        Assert.isNull(unchangedRepeat.Repeat_Source_Question__c);
        repeat.Repeat_Source_Question__c = count.Id;
        update repeat;
        count.Type__c = 'decimal';
        assertRejected(Database.update(count, false));
        repeat.Repeat_Mode__c = 'open';
        repeat.Repeat_Source_Question__c = null;
        assertAllRejected(
            Database.update(new List<Question__c>{ count, repeat }, false)
        );
        update repeat;
        update count;
    }

    @IsTest
    static void lineageRequiresDifferentVersionOfSameForm() {
        Form_Version__c first = createVersion('Synthetic lineage form', 1);
        Form_Version__c second = new Form_Version__c(
            Form__c = first.Form__c,
            Version_Number__c = 2
        );
        insert second;
        Form_Version__c foreign = createVersion('Synthetic foreign lineage', 1);
        Question__c previous = question(first.Id, 'question', 'text', 1);
        Question__c foreignQuestion = question(
            foreign.Id,
            'foreign_question',
            'text',
            1
        );
        insert new List<Question__c>{ previous, foreignQuestion };
        Question__c current = question(second.Id, 'question', 'text', 1);
        current.Previous_Version_Question__c = previous.Id;
        insert current;
        current.Previous_Version_Question__c = foreignQuestion.Id;
        assertRejected(Database.update(current, false));
        current.Previous_Version_Question__c = current.Id;
        assertRejected(
            Database.update(current, false),
            StatusCode.CIRCULAR_DEPENDENCY
        );
        Assert.areEqual(
            previous.Id,
            [
                SELECT Previous_Version_Question__c
                FROM Question__c
                WHERE Id = :current.Id
            ]
            .Previous_Version_Question__c
        );
        Question__c sibling = question(second.Id, 'sibling', 'text', 2);
        insert sibling;
        current.Previous_Version_Question__c = sibling.Id;
        assertRejected(Database.update(current, false));
        current.Previous_Version_Question__c = previous.Id;
        current.Hint__c = 'Independent author edit';
        update current;
        // Updating an old definition with a newer one in the same batch must
        // resolve its form from version identity, not unloaded relationship data.
        previous.Hint__c = 'Synthetic previous-version hint';
        update new List<Question__c>{ previous, current };
    }

    @IsTest
    static void definitionCannotBeReparentedToAnotherVersion() {
        Form_Version__c first = createVersion('Synthetic immutable owner', 1);
        Form_Version__c second = new Form_Version__c(
            Form__c = first.Form__c,
            Version_Number__c = 2
        );
        insert second;
        Question__c definition = question(first.Id, 'question', 'text', 1);
        insert definition;
        Integer dmlBefore = Limits.getDmlStatements();
        Boolean rejected = false;
        try {
            // Non-reparentable master-detail ownership is enforced by the
            // platform at assignment on this persisted record, before DML.
            definition.Form_Version__c = second.Id;
        } catch (SObjectException error) {
            rejected = true;
            Assert.isTrue(
                error.getMessage().startsWith('Field is not writeable: ')
            );
            // Keep the assertion valid with either local or namespaced names.
            Assert.isTrue(error.getMessage().endsWith('Form_Version__c'));
        }
        Assert.isTrue(
            rejected,
            'Persisted definition ownership must be immutable'
        );
        Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        Question__c unchanged = [
            SELECT Form_Version__c, Question_Key__c
            FROM Question__c
            WHERE Id = :definition.Id
        ];
        Assert.areEqual(first.Id, unchanged.Form_Version__c);
        Assert.areEqual(
            String.valueOf(first.Id) + ':question',
            unchanged.Question_Key__c
        );
    }

    @IsTest
    static void orderAndNumericBoundsRejectFractionsAndInvalidRanges() {
        Form_Version__c version = createVersion('Synthetic numeric fields', 1);
        List<Question__c> invalid = new List<Question__c>();
        for (Decimal order : new List<Decimal>{ -1, 0, 1.5 }) {
            Question__c definition = question(
                version.Id,
                'bad_order_' + invalid.size(),
                'integer',
                1
            );
            definition.Order__c = order;
            invalid.add(definition);
        }
        Question__c reversed = question(
            version.Id,
            'reversed_range',
            'integer',
            1
        );
        reversed.Minimum__c = 5;
        reversed.Maximum__c = 4;
        invalid.add(reversed);
        Question__c fractionalCount = question(
            version.Id,
            'fractional_count',
            'repeat',
            1
        );
        fractionalCount.Repeat_Mode__c = 'fixed';
        fractionalCount.Repeat_Count__c = 1.5;
        invalid.add(fractionalCount);
        Question__c invalidMaximum = question(
            version.Id,
            'negative_maximum',
            'repeat',
            1
        );
        invalidMaximum.Repeat_Max__c = -1;
        invalid.add(invalidMaximum);
        Question__c invalidMedia = question(
            version.Id,
            'invalid_media',
            'audio',
            1
        );
        invalidMedia.Media_Max_Seconds__c = 0;
        invalid.add(invalidMedia);
        Question__c invalidCascade = question(
            version.Id,
            'invalid_cascade',
            'text',
            1
        );
        invalidCascade.Cascade_Level__c = 1.5;
        invalid.add(invalidCascade);
        assertAllRejected(Database.insert(invalid, false));
    }

    @IsTest
    static void reusableAndInlineChoiceListsHaveExplicitOwnership() {
        Form_Version__c version = createVersion(
            'Synthetic list association',
            1
        );
        Choice_List__c shared = new Choice_List__c(
            Name = 'Synthetic reusable list'
        );
        insert shared;
        Question__c first = question(
            version.Id,
            'first_select',
            'select_one',
            1
        );
        first.Choice_List__c = shared.Id;
        Question__c second = question(
            version.Id,
            'second_select',
            'select_multiple',
            2
        );
        second.Choice_List__c = shared.Id;
        insert new List<Question__c>{ first, second };
        Choice_List__c inline = new Choice_List__c(
            Name = 'Synthetic inline list',
            Owner_Question__c = first.Id
        );
        insert inline;
        first.Choice_List__c = inline.Id;
        update first;
        second.Choice_List__c = inline.Id;
        assertRejected(Database.update(second, false));
        Question__c notSelect = question(version.Id, 'not_select', 'text', 3);
        notSelect.Choice_List__c = shared.Id;
        assertRejected(Database.insert(notSelect, false));
        first.Choice_List__c = null;
        first.Type__c = 'text';
        assertRejected(Database.update(first, false));
        first.Type__c = 'select_multiple';
        update first;
        Assert.areEqual(
            first.Id,
            [SELECT Owner_Question__c FROM Choice_List__c WHERE Id = :inline.Id]
            .Owner_Question__c
        );
    }

    @IsTest
    static void schemaKeepsLocalTypedReferencesAndSeparateNarrativeFields() {
        Assert.areEqual(
            'Question__c',
            Question__c.SObjectType.getDescribe().getLocalName()
        );
        Assert.areEqual(
            Form_Version__c.SObjectType,
            Question__c.Form_Version__c.getDescribe().getReferenceTo()[0]
        );
        Assert.areEqual(
            Question__c.SObjectType,
            Question__c.Parent__c.getDescribe().getReferenceTo()[0]
        );
        Assert.areEqual(
            Question__c.SObjectType,
            Question__c.Repeat_Source_Question__c.getDescribe()
                .getReferenceTo()[0]
        );
        Assert.areEqual(
            Question__c.SObjectType,
            Question__c.Previous_Version_Question__c.getDescribe()
                .getReferenceTo()[0]
        );
        Assert.areEqual(
            Choice_List__c.SObjectType,
            Question__c.Choice_List__c.getDescribe().getReferenceTo()[0]
        );
        Assert.isTrue(Question__c.Question_Key__c.getDescribe().isUnique());
        Assert.isTrue(
            Question__c.Question_Key__c.getDescribe().isCaseSensitive()
        );
        Assert.areEqual(
            100,
            Question__c.Question_Key__c.getDescribe().getLength()
        );
        Assert.isFalse(Question__c.Order__c.getDescribe().isNillable());
        Assert.areEqual(
            Schema.DisplayType.TextArea,
            Question__c.Hint__c.getDescribe().getType()
        );
        Assert.areEqual(
            Schema.DisplayType.TextArea,
            Question__c.Author_Notes__c.getDescribe().getType()
        );
        Assert.areEqual(
            32768,
            Question__c.Author_Notes__c.getDescribe().getLength()
        );
    }

    private static Form_Version__c createVersion(
        String name,
        Integer numberValue
    ) {
        Form__c form = new Form__c(Name = name);
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = numberValue
        );
        insert version;
        return version;
    }

    private static Question__c question(
        Id versionId,
        String name,
        String typeName,
        Integer order
    ) {
        Question__c definition = new Question__c(
            Form_Version__c = versionId,
            Name = name,
            Type__c = typeName,
            Order__c = order,
            Label__c = 'Synthetic question label'
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

    private static void assertRejected(Database.SaveResult result) {
        assertRejected(result, StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION);
    }

    private static void assertRejected(
        Database.SaveResult result,
        StatusCode expectedStatus
    ) {
        Assert.isFalse(
            result.isSuccess(),
            'Invalid synthetic definition must not persist'
        );
        Assert.areEqual(expectedStatus, result.getErrors()[0].getStatusCode());
    }
}
