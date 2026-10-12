/**
 * Responsibility: maintain exactly one scoped Edit share from a Form to its
 * explicitly selected Publisher. This trigger-only system boundary never chooses
 * a publisher, grants object/FLS/custom-permission access or creates a user.
 * It reconciles only publisher/owner changes in one query and at most two DML.
 */
public without sharing class PublisherRecordAccess {
    public static void reconcile(
        List<Form__c> current,
        Map<Id, Form__c> previous
    ) {
        Map<Id, Form__c> changed = new Map<Id, Form__c>();
        for (Form__c form : current) {
            Form__c before = previous == null ? null : previous.get(form.Id);
            if (
                before == null ||
                form.Publisher__c != before.Publisher__c ||
                form.OwnerId != before.OwnerId
            ) {
                changed.put(form.Id, form);
            }
        }
        if (changed.isEmpty()) {
            return;
        }

        String publisherCause = String.valueOf(
            Schema.Form__Share.RowCause.Publisher_Access__c
        );
        Set<Id> changedIds = changed.keySet();
        List<Form__Share> existing = [
            SELECT Id
            FROM Form__Share
            WHERE ParentId IN :changedIds AND RowCause = :publisherCause
        ];
        if (!existing.isEmpty()) {
            delete existing;
        }

        List<Form__Share> desired = new List<Form__Share>();
        for (Form__c form : changed.values()) {
            if (
                form.Publisher__c != null &&
                form.Publisher__c != form.OwnerId
            ) {
                desired.add(
                    new Form__Share(
                        ParentId = form.Id,
                        UserOrGroupId = form.Publisher__c,
                        AccessLevel = 'Edit',
                        RowCause = Schema.Form__Share.RowCause.Publisher_Access__c
                    )
                );
            }
        }
        if (!desired.isEmpty()) {
            insert desired;
        }
    }
}
