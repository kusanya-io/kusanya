/** Responsibility: enforce definition ownership, explicit sources and target identity. */
trigger FieldMappingDefinition on Field_Mapping__c(
  before insert,
  before update
) {
  FieldMappingDefinitionHandler.validateFields(Trigger.new, Trigger.oldMap);
}
