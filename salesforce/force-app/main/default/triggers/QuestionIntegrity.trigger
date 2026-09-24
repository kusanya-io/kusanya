/**
 * Responsibility: invoke serialized, bulk-safe integrity checks for question writes.
 * This is not the compiler, publication workflow, or collector authorization path.
 */
trigger QuestionIntegrity on Question__c(
  before insert,
  before update,
  before delete
) {
  PublishedDefinitionGuard.protectQuestions(
    Trigger.isDelete ? Trigger.old : Trigger.new
  );
  if (Trigger.isDelete) {
    QuestionIntegrityHandler.validateDeletion(Trigger.oldMap);
  } else {
    QuestionIntegrityHandler.validateQuestions(Trigger.new, Trigger.oldMap);
  }
}
