/** Responsibility: validate skip rules and protect published snapshots. */
trigger SkipRuleIntegrity on Skip_Rule__c(
  before insert,
  before update,
  before delete
) {
  PublishedDefinitionGuard.protectSkipRules(
    Trigger.isDelete ? Trigger.old : Trigger.new
  );
  if (!Trigger.isDelete) {
    SkipRuleDefinitionHandler.validate(Trigger.new);
  }
}
