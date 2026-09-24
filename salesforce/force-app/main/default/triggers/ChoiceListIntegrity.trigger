/** Responsibility: validate inline ownership and immutable publication snapshots. */
trigger ChoiceListIntegrity on Choice_List__c(
  before insert,
  before update,
  before delete
) {
  PublishedDefinitionGuard.protectChoiceLists(
    Trigger.isDelete ? Trigger.old : Trigger.new
  );
  if (!Trigger.isDelete) {
    ChoiceDefinitionHandler.validateLists(
      Trigger.new,
      Trigger.isUpdate ? Trigger.oldMap : null
    );
  }
}
