/** Responsibility: derive bulk-safe unique choice values within a choice list. */
trigger ChoiceIdentity on Choice__c(before insert, before update) {
  ChoiceDefinitionHandler.assignChoiceKeys(Trigger.new);
}
