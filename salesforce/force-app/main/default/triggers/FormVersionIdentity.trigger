/**
 * Responsibility: invoke bulk-safe identity derivation for form version writes.
 * Publication and lifecycle transitions are outside this trigger's responsibility.
 */
trigger FormVersionIdentity on Form_Version__c(before insert, before update) {
  FormVersionIdentityHandler.assignKeys(Trigger.new);
}
