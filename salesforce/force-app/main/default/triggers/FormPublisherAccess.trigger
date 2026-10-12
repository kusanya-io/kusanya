/** Responsibility: reconcile explicit per-Form publisher sharing after writes. */
trigger FormPublisherAccess on Form__c(
  after insert,
  after update,
  after undelete
) {
  PublisherRecordAccess.reconcile(
    Trigger.new,
    Trigger.isUpdate ? Trigger.oldMap : null
  );
}
