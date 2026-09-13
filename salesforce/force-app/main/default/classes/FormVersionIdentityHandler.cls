/**
 * Responsibility: derive a unique per-form version identity before insert or update.
 * Does not query, mutate other records, authorize access, or publish versions.
 */
public with sharing class FormVersionIdentityHandler {
    public static void assignKeys(List<Form_Version__c> versions) {
        for (Form_Version__c version : versions) {
            version.Version_Key__c = null;
            Decimal numberValue = version.Version_Number__c;
            if (
                version.Form__c != null &&
                numberValue != null &&
                numberValue >= 1 &&
                numberValue == numberValue.setScale(0)
            ) {
                version.Version_Key__c =
                    String.valueOf(version.Form__c) +
                    ':' +
                    String.valueOf(numberValue.setScale(0));
            }
        }
    }
}
