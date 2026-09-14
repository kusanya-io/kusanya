/**
 * Responsibility: derive version identity on writes and clear owned skip rules before direct deletion.
 * Publication and full lifecycle transitions remain outside this trigger's responsibility.
 */
trigger FormVersionIdentity on Form_Version__c(
  before insert,
  before update,
  before delete
) {
  if (Trigger.isDelete) {
    DefinitionDeletionHandler.beforeVersionsDelete(Trigger.oldMap.keySet());
  } else {
    FormVersionIdentityHandler.assignKeys(Trigger.new);
  }
}
