/**
 * Responsibility: invoke serialized, bulk-safe integrity checks for question writes.
 * This is not the compiler, publication workflow, or collector authorization path.
 */
trigger QuestionIntegrity on Question__c(before insert, before update) {
  QuestionIntegrityHandler.validateQuestions(Trigger.new, Trigger.oldMap);
}
