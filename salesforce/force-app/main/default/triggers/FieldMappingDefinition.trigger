/** Responsibility: enforce definition ownership, explicit sources and target identity. */
trigger FieldMappingDefinition on Field_Mapping__c(
  before insert,
  before update,
  before delete
) {
  PublishedDefinitionGuard.protectFieldMappings(
    Trigger.isDelete ? Trigger.old : Trigger.new
  );
  if (!Trigger.isDelete) {
    FieldMappingDefinitionHandler.validateFields(Trigger.new, Trigger.oldMap);
  }
}
