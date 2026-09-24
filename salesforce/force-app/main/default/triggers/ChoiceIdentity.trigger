/** Responsibility: derive choice identity and protect published choice snapshots. */
trigger ChoiceIdentity on Choice__c(
  before insert,
  before update,
  before delete
) {
  PublishedDefinitionGuard.protectChoices(
    Trigger.isDelete ? Trigger.old : Trigger.new
  );
  if (!Trigger.isDelete) {
    ChoiceDefinitionHandler.assignChoiceKeys(Trigger.new);
  }
}
