/**
 * Responsibility: constrain skip-rule references and operator operand shapes.
 * Integrity-only system reads do not compile relevance or expose definition data.
 */
public without sharing class SkipRuleDefinitionHandler {
    public static void validate(List<Skip_Rule__c> rules) {
        Set<Id> questionIds = new Set<Id>();
        for (Skip_Rule__c rule : rules) {
            if (rule.Question__c != null)
                questionIds.add(rule.Question__c);
            if (rule.Source_Question__c != null)
                questionIds.add(rule.Source_Question__c);
        }
        Map<Id, Question__c> questions = new Map<Id, Question__c>(
            [
                SELECT Id, Form_Version__c
                FROM Question__c
                WHERE Id IN :questionIds
            ]
        );
        for (Skip_Rule__c rule : rules) {
            Question__c target = questions.get(rule.Question__c);
            Question__c source = questions.get(rule.Source_Question__c);
            if (
                target == null ||
                source == null ||
                target.Id == source.Id ||
                target.Form_Version__c != source.Form_Version__c
            ) {
                rule.addError(
                    'A skip rule requires distinct target and source questions in one version.'
                );
            }
            if (rule.Operator__c == 'answered') {
                if (
                    !String.isBlank(rule.Value__c) ||
                    !String.isBlank(rule.Value_To__c)
                ) {
                    rule.addError('The answered operator takes no values.');
                }
            } else if (String.isBlank(rule.Value__c)) {
                rule.addError('This skip operator requires Value.');
            }
            if (rule.Operator__c == 'in_range') {
                if (String.isBlank(rule.Value_To__c)) {
                    rule.addError('The in_range operator requires Value To.');
                }
            } else if (!String.isBlank(rule.Value_To__c)) {
                rule.addError('Only the in_range operator takes Value To.');
            }
        }
    }
}
