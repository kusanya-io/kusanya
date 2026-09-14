/** Responsibility: validate inline-list ownership before definition writes. */
trigger ChoiceListIntegrity on Choice_List__c(before insert, before update) {
  ChoiceDefinitionHandler.validateLists(
    Trigger.new,
    Trigger.isUpdate ? Trigger.oldMap : null
  );
}
