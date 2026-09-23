/** Responsibility: protect lifecycle-owned Form fields and published deletion. */
trigger FormDefinitionDeletion on Form__c(
  before insert,
  before update,
  before delete
) {
  if (Trigger.isDelete) {
    PublicationLifecycle.validateFormDeletion(Trigger.old);
    DefinitionDeletionHandler.beforeFormsDelete(Trigger.oldMap.keySet());
  } else {
    PublicationLifecycle.validateForms(
      Trigger.new,
      Trigger.isUpdate ? Trigger.oldMap : null
    );
  }
}
