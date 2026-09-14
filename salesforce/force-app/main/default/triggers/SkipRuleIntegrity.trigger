/** Responsibility: validate skip-rule question references on every write. */
trigger SkipRuleIntegrity on Skip_Rule__c(before insert, before update) {
  SkipRuleDefinitionHandler.validate(Trigger.new);
}
