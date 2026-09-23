/**
 * Responsibility: invoke stored mapping integrity and direct-delete protection.
 * This is not a publishing, target-write, or target-authorization entry point.
 */
trigger MappingDefinition on Mapping__c(
  before insert,
  before update,
  before delete
) {
  PublishedDefinitionGuard.protectMappings(
    Trigger.isDelete ? Trigger.old : Trigger.new
  );
  if (Trigger.isDelete) {
    MappingDefinitionHandler.validateDeletion(Trigger.oldMap);
  } else {
    MappingDefinitionHandler.validateMappings(Trigger.new, Trigger.oldMap);
  }
}
