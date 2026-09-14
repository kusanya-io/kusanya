/** Responsibility: clear only this Form's owned skip rules before its detail cascade. */
trigger FormDefinitionDeletion on Form__c(before delete) {
  DefinitionDeletionHandler.beforeFormsDelete(Trigger.oldMap.keySet());
}
