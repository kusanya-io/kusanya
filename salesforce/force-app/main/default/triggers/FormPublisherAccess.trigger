/** Responsibility: enforce and reconcile explicit per-Form publisher access. */
trigger FormPublisherAccess on Form__c(
  before update,
  after insert,
  after update,
  after undelete
) {
  if (Trigger.isBefore) {
    PublisherRecordAccess.validateOwnerTransfers(Trigger.new, Trigger.oldMap);
  } else {
    PublisherRecordAccess.reconcile(
      Trigger.new,
      Trigger.isUpdate ? Trigger.oldMap : null
    );
  }
}
