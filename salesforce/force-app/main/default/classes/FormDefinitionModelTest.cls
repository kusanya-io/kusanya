/**
 * Responsibility: verify the initial form schema and version identity with synthetic data.
 * Does not prove publishing, file lifecycle, permission enforcement, or brief C10 tests.
 * Typed local API references are compatible by design; namespaced execution is pending.
 */
@IsTest
private class FormDefinitionModelTest {
    @IsTest
    static void createsHierarchyWithSafeDefaults() {
        Folder__c folder = new Folder__c(
            Name = 'Synthetic forms',
            Description__c = 'Synthetic folder description'
        );
        insert folder;
        Form__c form = new Form__c(
            Name = 'Synthetic observation',
            Description__c = 'Synthetic form description',
            Folder__c = folder.Id,
            Default_Target_Object__c = 'Account',
            Language__c = 'en',
            Country__c = 'Synthetic country',
            Close_Message__c = 'Collection is closed'
        );
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1,
            Change_Log__c = 'Initial synthetic definition'
        );
        insert version;
        form.Current_Version__c = version.Id;
        update form;

        Form__c saved = [
            SELECT
                Status__c,
                GPS_Capture__c,
                Allow_Ad_Hoc_Submissions__c,
                Folder__r.Description__c,
                Description__c,
                Default_Target_Object__c,
                Language__c,
                Country__c,
                Close_Message__c,
                Current_Version__r.Version_Number__c,
                Current_Version__r.Status__c,
                Current_Version__r.Change_Log__c,
                Current_Version__r.Version_Key__c
            FROM Form__c
            WHERE Id = :form.Id
        ];
        Assert.areEqual('Draft', saved.Status__c);
        Assert.areEqual('none', saved.GPS_Capture__c);
        Assert.isFalse(saved.Allow_Ad_Hoc_Submissions__c);
        Assert.areEqual(
            'Synthetic folder description',
            saved.Folder__r.Description__c
        );
        Assert.areEqual('Synthetic form description', saved.Description__c);
        Assert.areEqual('Account', saved.Default_Target_Object__c);
        Assert.areEqual('en', saved.Language__c);
        Assert.areEqual('Synthetic country', saved.Country__c);
        Assert.areEqual('Collection is closed', saved.Close_Message__c);
        Assert.areEqual(1, saved.Current_Version__r.Version_Number__c);
        Assert.areEqual('Draft', saved.Current_Version__r.Status__c);
        Assert.areEqual(
            'Initial synthetic definition',
            saved.Current_Version__r.Change_Log__c
        );
        Assert.areEqual(
            String.valueOf(form.Id) + ':1',
            saved.Current_Version__r.Version_Key__c
        );
    }

    @IsTest
    static void rejectsNonPositiveAndFractionalVersions() {
        Form__c form = createForm('Synthetic invalid versions');
        List<Form_Version__c> invalidVersions = new List<Form_Version__c>();
        for (Decimal numberValue : new List<Decimal>{ -1, 0, 1.5 }) {
            invalidVersions.add(
                new Form_Version__c(
                    Form__c = form.Id,
                    Version_Number__c = numberValue
                )
            );
        }
        List<Database.SaveResult> results = Database.insert(
            invalidVersions,
            false
        );
        for (Database.SaveResult result : results) {
            Assert.isFalse(
                result.isSuccess(),
                'Non-positive and fractional versions must fail'
            );
            Assert.areEqual(
                StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
                result.getErrors()[0].getStatusCode()
            );
            Assert.isTrue(
                result.getErrors()[0]
                    .getMessage()
                    .contains('positive whole number')
            );
        }
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Form_Version__c WHERE Form__c = :form.Id]
        );
    }

    @IsTest
    static void requiresOwningFormAndVersionNumber() {
        Form__c form = createForm('Synthetic required values');
        List<Database.SaveResult> results = Database.insert(
            new List<Form_Version__c>{
                new Form_Version__c(Version_Number__c = 1),
                new Form_Version__c(Form__c = form.Id)
            },
            false
        );
        for (Database.SaveResult result : results) {
            Assert.isFalse(
                result.isSuccess(),
                'Incomplete version identities must not persist'
            );
        }
    }

    @IsTest
    static void currentVersionMustBelongToThisForm() {
        Form__c firstForm = createForm('Synthetic first form');
        Form__c secondForm = createForm('Synthetic second form');
        Form_Version__c secondVersion = new Form_Version__c(
            Form__c = secondForm.Id,
            Version_Number__c = 1
        );
        insert secondVersion;
        firstForm.Current_Version__c = secondVersion.Id;
        Database.SaveResult result = Database.update(firstForm, false);
        Assert.isFalse(result.isSuccess());
        Assert.areEqual(
            StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
            result.getErrors()[0].getStatusCode()
        );
        Assert.isTrue(
            result.getErrors()[0]
                .getMessage()
                .contains('must belong to this form')
        );
    }

    @IsTest
    static void versionNumbersAreUniqueWithinEachFormOnInsertAndUpdate() {
        Form__c firstForm = createForm('Synthetic unique first');
        Form__c secondForm = createForm('Synthetic unique second');
        List<Form_Version__c> versions = new List<Form_Version__c>{
            new Form_Version__c(Form__c = firstForm.Id, Version_Number__c = 1),
            new Form_Version__c(Form__c = firstForm.Id, Version_Number__c = 2),
            new Form_Version__c(Form__c = secondForm.Id, Version_Number__c = 1)
        };
        insert versions;
        Database.SaveResult duplicateInsert = Database.insert(
            new Form_Version__c(Form__c = firstForm.Id, Version_Number__c = 1),
            false
        );
        Assert.isFalse(duplicateInsert.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicateInsert.getErrors()[0].getStatusCode()
        );
        versions[1].Version_Number__c = 1;
        Database.SaveResult duplicateUpdate = Database.update(
            versions[1],
            false
        );
        Assert.isFalse(duplicateUpdate.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicateUpdate.getErrors()[0].getStatusCode()
        );
        Assert.areEqual(3, [SELECT COUNT() FROM Form_Version__c]);
    }

    @IsTest
    static void derivesIdentityInBulkAndOverwritesCallerKeys() {
        Form__c form = createForm('Synthetic bulk versions');
        List<Form_Version__c> versions = new List<Form_Version__c>();
        for (Integer numberValue = 1; numberValue <= 200; numberValue++) {
            versions.add(
                new Form_Version__c(
                    Form__c = form.Id,
                    Version_Number__c = numberValue,
                    Version_Key__c = 'caller-controlled'
                )
            );
        }
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        insert versions;
        Assert.areEqual(
            queriesBefore,
            Limits.getQueries(),
            'Identity derivation must not query'
        );
        Assert.areEqual(
            dmlBefore + 1,
            Limits.getDmlStatements(),
            'Identity derivation must not perform its own DML'
        );
        List<Form_Version__c> saved = [
            SELECT Version_Number__c, Version_Key__c
            FROM Form_Version__c
            WHERE Form__c = :form.Id
            ORDER BY Version_Number__c
        ];
        Assert.areEqual(200, saved.size());
        for (Form_Version__c version : saved) {
            Assert.areEqual(
                String.valueOf(form.Id) +
                    ':' +
                    String.valueOf(version.Version_Number__c.setScale(0)),
                version.Version_Key__c
            );
        }
        saved[0].Version_Number__c = 201;
        saved[0].Version_Key__c = 'replacement-caller-key';
        update saved[0];
        Id updatedVersionId = saved[0].Id;
        Form_Version__c updated = [
            SELECT Version_Key__c
            FROM Form_Version__c
            WHERE Id = :updatedVersionId
        ];
        Assert.areEqual(
            String.valueOf(form.Id) + ':201',
            updated.Version_Key__c
        );
    }

    @IsTest
    static void identityHandlerDoesNotNormalizeInvalidInputOrAccessData() {
        Form__c form = createForm('Synthetic handler guard');
        List<Form_Version__c> invalidVersions = new List<Form_Version__c>{
            new Form_Version__c(
                Version_Number__c = 1,
                Version_Key__c = 'supplied'
            ),
            new Form_Version__c(Form__c = form.Id, Version_Key__c = 'supplied'),
            new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 0,
                Version_Key__c = 'supplied'
            ),
            new Form_Version__c(
                Form__c = form.Id,
                Version_Number__c = 1.5,
                Version_Key__c = 'supplied'
            )
        };
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        FormVersionIdentityHandler.assignKeys(invalidVersions);
        Assert.areEqual(queriesBefore, Limits.getQueries());
        Assert.areEqual(dmlBefore, Limits.getDmlStatements());
        for (Form_Version__c version : invalidVersions) {
            Assert.isNull(version.Version_Key__c);
        }
        Assert.areEqual(
            1.5,
            invalidVersions[3].Version_Number__c,
            'Validation must receive the original fractional input'
        );
    }

    @IsTest
    static void deletingDraftHierarchyUsesDeclaredRelationships() {
        Folder__c folder = new Folder__c(Name = 'Synthetic deletable folder');
        insert folder;
        Form__c form = new Form__c(
            Name = 'Synthetic deletable draft',
            Folder__c = folder.Id
        );
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        form.Current_Version__c = version.Id;
        update form;

        delete folder;
        Assert.isNull(
            [SELECT Folder__c FROM Form__c WHERE Id = :form.Id].Folder__c
        );
        delete version;
        Assert.isNull(
            [SELECT Current_Version__c FROM Form__c WHERE Id = :form.Id]
            .Current_Version__c
        );

        Form_Version__c child = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 2
        );
        insert child;
        delete form;
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Form_Version__c WHERE Id = :child.Id]
        );
    }

    @IsTest
    static void schemaUsesLocalApiNamesAndTypedRelationships() {
        Assert.areEqual(
            'Folder__c',
            Folder__c.SObjectType.getDescribe().getLocalName()
        );
        Assert.areEqual(
            'Form__c',
            Form__c.SObjectType.getDescribe().getLocalName()
        );
        Assert.areEqual(
            'Form_Version__c',
            Form_Version__c.SObjectType.getDescribe().getLocalName()
        );
        Assert.areEqual(
            Folder__c.SObjectType,
            Form__c.Folder__c.getDescribe().getReferenceTo()[0]
        );
        Assert.areEqual(
            Form_Version__c.SObjectType,
            Form__c.Current_Version__c.getDescribe().getReferenceTo()[0]
        );
        Assert.areEqual(
            Form__c.SObjectType,
            Form_Version__c.Form__c.getDescribe().getReferenceTo()[0]
        );
        Assert.areEqual(
            User.SObjectType,
            Form_Version__c.Published_By__c.getDescribe().getReferenceTo()[0]
        );
        Assert.isTrue(Form_Version__c.Version_Key__c.getDescribe().isUnique());
        Assert.isFalse(
            Form_Version__c.Version_Number__c.getDescribe().isNillable()
        );
        Assert.areEqual(
            0,
            Form_Version__c.Version_Number__c.getDescribe().getScale()
        );
        Assert.areEqual(
            Schema.DisplayType.String,
            Form_Version__c.XForm__c.getDescribe().getType()
        );
        Assert.areEqual(18, Form_Version__c.XForm__c.getDescribe().getLength());
        Assert.areEqual(
            Schema.DisplayType.String,
            Form_Version__c.XLSForm__c.getDescribe().getType()
        );
        Assert.areEqual(
            18,
            Form_Version__c.XLSForm__c.getDescribe().getLength()
        );
    }

    private static Form__c createForm(String name) {
        Form__c form = new Form__c(Name = name);
        insert form;
        return form;
    }
}
