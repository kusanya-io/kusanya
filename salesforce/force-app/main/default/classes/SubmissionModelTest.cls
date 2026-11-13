/**
 * Responsibility: prove the Phase 2 submission, answer, error and sync model
 * retains idempotency identity, typed answer evidence, private ownership and
 * parent lifecycles without creating any collector Salesforce user.
 */
@IsTest
private class SubmissionModelTest {
    @IsTest
    static void storesSubmissionAnswersErrorsAndSyncEvidence() {
        Form__c form = new Form__c(Name = 'Phase 2 intake');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        String digest = EncodingUtil.convertToHex(
            Crypto.generateDigest('SHA-256', Blob.valueOf('<data/>'))
        );
        Submission__c submission = new Submission__c(
            Form_Version__c = version.Id,
            Instance_Id__c = 'uuid:123e4567-e89b-12d3-a456-426614174000',
            Channel__c = 'phone',
            Received_At__c = DateTime.now(),
            XML_Hash__c = digest
        );
        insert submission;
        submission = [
            SELECT Status__c, Attempts__c
            FROM Submission__c
            WHERE Id = :submission.Id
        ];
        Assert.areEqual('Received', submission.Status__c);
        Assert.areEqual(0, submission.Attempts__c);

        Answer__c unknown = new Answer__c(
            Submission__c = submission.Id,
            Node_Name__c = 'future_node',
            Repeat_Path__c = '/students[2]',
            Repeat_Index__c = 2,
            Value__c = 'retained verbatim'
        );
        insert unknown;
        Assert.isNull(
            [SELECT Question__c FROM Answer__c WHERE Id = :unknown.Id]
            .Question__c
        );
        Error_Log__c failure = new Error_Log__c(
            Submission__c = submission.Id,
            Stage__c = 'mapping',
            Error_Code__c = 'UNKNOWN_PICKLIST_VALUE',
            Detail__c = 'Synthetic fixed test detail',
            Attempt__c = 1,
            Occurred_At__c = DateTime.now()
        );
        insert failure;
        Sync_Log__c sync = new Sync_Log__c(
            Started_At__c = DateTime.now(),
            Status__c = 'Started',
            Received_Count__c = 1,
            Mapped_Count__c = 0,
            Failed_Count__c = 1,
            Salesforce_Request_Count__c = 1,
            Duration_Milliseconds__c = 20,
            Error_Code__c = 'SYNTHETIC_FAILURE'
        );
        insert sync;

        delete submission;
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Answer__c WHERE Id = :unknown.Id]
        );
        Assert.areEqual(
            0,
            [SELECT COUNT() FROM Error_Log__c WHERE Id = :failure.Id]
        );
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Sync_Log__c WHERE Id = :sync.Id]
        );
    }

    @IsTest
    static void instanceIdentityIsUniqueAndProtectsItsDefinition() {
        Form__c form = new Form__c(Name = 'Protected intake');
        insert form;
        Form_Version__c version = new Form_Version__c(
            Form__c = form.Id,
            Version_Number__c = 1
        );
        insert version;
        String instanceId = 'uuid:123e4567-e89b-12d3-a456-426614174001';
        Submission__c first = submission(version.Id, instanceId);
        insert first;
        Database.SaveResult duplicate = Database.insert(
            submission(version.Id, instanceId),
            false
        );
        Assert.isFalse(duplicate.isSuccess());
        Assert.areEqual(
            StatusCode.DUPLICATE_VALUE,
            duplicate.getErrors()[0].getStatusCode()
        );
        String uppercaseHex = 'uuid:' + instanceId.substring(5).toUpperCase();
        Database.SaveResult caseVariant = Database.insert(
            submission(version.Id, uppercaseHex),
            false
        );
        Assert.isFalse(caseVariant.isSuccess());
        Assert.areEqual(
            StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
            caseVariant.getErrors()[0].getStatusCode()
        );
        Database.DeleteResult protectedVersion = Database.delete(
            version,
            false
        );
        Assert.isFalse(protectedVersion.isSuccess());
        Assert.areEqual(
            1,
            [SELECT COUNT() FROM Submission__c WHERE Id = :first.Id]
        );
    }

    @IsTest
    static void metadataCarriesTheRequiredSecurityAndIdentityShapes() {
        Assert.areEqual(
            Schema.DisplayType.STRING,
            Submission__c.Instance_Id__c.getDescribe().getType()
        );
        Assert.isTrue(Submission__c.Instance_Id__c.getDescribe().isUnique());
        Assert.isTrue(
            Submission__c.Instance_Id__c.getDescribe().isExternalId()
        );
        Assert.areEqual(
            Schema.DisplayType.REFERENCE,
            Submission__c.Form_Version__c.getDescribe().getType()
        );
        Assert.areEqual(
            Schema.DisplayType.REFERENCE,
            Answer__c.Submission__c.getDescribe().getType()
        );
        Assert.isTrue(Submission__c.SObjectType.getDescribe().isCreateable());
        Assert.isTrue(Answer__c.SObjectType.getDescribe().isCreateable());
    }

    private static Submission__c submission(Id versionId, String instanceId) {
        return new Submission__c(
            Form_Version__c = versionId,
            Instance_Id__c = instanceId,
            Channel__c = 'phone',
            Received_At__c = DateTime.now(),
            XML_Hash__c = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        );
    }
}
