/**
 * Responsibility: derive version identity and enforce publication-owned lifecycle changes.
 */
trigger FormVersionIdentity on Form_Version__c(
  before insert,
  before update,
  before delete
) {
  if (Trigger.isDelete) {
    PublicationLifecycle.validateVersions(Trigger.old, Trigger.oldMap, true);
    DefinitionDeletionHandler.beforeVersionsDelete(Trigger.oldMap.keySet());
  } else {
    FormVersionIdentityHandler.assignKeys(Trigger.new);
    PublicationLifecycle.validateVersions(
      Trigger.new,
      Trigger.isUpdate ? Trigger.oldMap : null,
      false
    );
  }
}
