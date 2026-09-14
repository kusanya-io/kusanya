/**
 * Responsibility: protect stored question identities, tree scope and repeat references.
 * Runs only from the write trigger; it is not a reader or an authorization API.
 * Without sharing is deliberate: hidden definitions still participate in integrity.
 * Version locks serialize writers, and old/new edges protect partial DML subsets.
 * Does not compile XPath, publish a form, create users, or perform its own DML.
 */
public without sharing class QuestionIntegrityHandler {
    private static final Pattern NODE_NAME = Pattern.compile(
        '^[A-Za-z_][A-Za-z0-9_.-]*$'
    );
    private static final String INVALID = 'Question definition is inconsistent. Check names, parent scope, repeat settings and lineage; stage dependent tree changes separately.';

    public static void validateDeletion(Map<Id, Question__c> deleting) {
        Set<Id> deletingIds = deleting.keySet();
        // Self-lookups support only Salesforce's default clear behavior. Guard
        // direct deletes without blocking edges wholly inside this trigger batch.
        // Parent master-detail cascades do not invoke this child delete trigger.
        List<Question__c> outsideDependants = [
            SELECT Id
            FROM Question__c
            WHERE
                Id NOT IN :deletingIds
                AND (Parent__c IN :deletingIds
                OR Repeat_Source_Question__c IN :deletingIds
                OR Previous_Version_Question__c IN :deletingIds)
            LIMIT 1
        ];
        if (!outsideDependants.isEmpty()) {
            // Fail this batch together; do not disclose hidden dependant records.
            for (Question__c question : deleting.values()) {
                question.addError(
                    'Cannot delete questions referenced by questions outside this delete batch.'
                );
            }
        }
    }

    public static void validateQuestions(
        List<Question__c> incoming,
        Map<Id, Question__c> original
    ) {
        Set<Id> versionIds = new Set<Id>();
        Set<Id> referenceIds = new Set<Id>();
        Set<Id> choiceListIds = new Set<Id>();
        Set<Id> questionIds = new Set<Id>();
        for (Question__c question : incoming) {
            question.Question_Key__c = null;
            if (question.Form_Version__c != null) {
                versionIds.add(question.Form_Version__c);
                if (validName(question.Name)) {
                    question.Question_Key__c =
                        String.valueOf(question.Form_Version__c) +
                        ':' +
                        question.Name;
                }
            }
            referenceIds.add(question.Parent__c);
            referenceIds.add(question.Repeat_Source_Question__c);
            referenceIds.add(question.Previous_Version_Question__c);
            choiceListIds.add(question.Choice_List__c);
            if (question.Id != null) {
                questionIds.add(question.Id);
                if (original != null) {
                    choiceListIds.add(original.get(question.Id).Choice_List__c);
                }
            }
        }
        referenceIds.remove(null);
        choiceListIds.remove(null);
        Map<Id, Form_Version__c> versions = new Map<Id, Form_Version__c>(
            [
                SELECT Id, Form__c
                FROM Form_Version__c
                WHERE Id IN :versionIds
                FOR UPDATE
            ]
        );
        Map<Id, Question__c> stored = new Map<Id, Question__c>(
            [
                SELECT
                    Id,
                    Name,
                    Form_Version__c,
                    Form_Version__r.Form__c,
                    Parent__c,
                    Type__c,
                    Repeat_Mode__c,
                    Repeat_Count__c,
                    Repeat_Source_Question__c,
                    Repeat_Max__c,
                    Repeat_As_Table__c,
                    Previous_Version_Question__c
                FROM Question__c
                WHERE Form_Version__c IN :versionIds OR Id IN :referenceIds
            ]
        );
        Map<Id, Question__c> proposed = stored.clone();
        Map<Id, Id> formByVersion = new Map<Id, Id>();
        for (Form_Version__c version : versions.values()) {
            formByVersion.put(version.Id, version.Form__c);
        }
        for (Question__c question : stored.values()) {
            formByVersion.put(
                question.Form_Version__c,
                question.Form_Version__r.Form__c
            );
        }
        for (Question__c question : incoming) {
            if (question.Id != null) {
                proposed.put(question.Id, question);
            }
        }
        Map<Id, Choice_List__c> choiceLists = new Map<Id, Choice_List__c>(
            [
                SELECT Id, Owner_Question__c
                FROM Choice_List__c
                WHERE Id IN :choiceListIds OR Owner_Question__c IN :questionIds
                FOR UPDATE
            ]
        );

        Boolean valid = true;
        for (Question__c question : incoming) {
            if (
                !validName(question.Name) ||
                !versions.containsKey(question.Form_Version__c) ||
                (original != null &&
                original.get(question.Id).Form_Version__c !=
                question.Form_Version__c) ||
                !validRepeatSettings(question) ||
                !validReferences(question, stored, formByVersion, true) ||
                !validReferences(question, proposed, formByVersion, true) ||
                !validChoiceList(question, choiceLists)
            ) {
                valid = false;
            }
        }
        // An edited container or count source cannot invalidate existing dependants,
        // even when a caller also edits those dependants in the same partial DML batch.
        for (Question__c question : stored.values()) {
            if (
                versionIds.contains(question.Form_Version__c) &&
                !validReferences(question, proposed, formByVersion, false)
            ) {
                valid = false;
            }
        }
        for (Choice_List__c choiceList : choiceLists.values()) {
            if (
                questionIds.contains(choiceList.Owner_Question__c) &&
                !isSelect(proposed.get(choiceList.Owner_Question__c))
            ) {
                valid = false;
            }
        }
        if (!acyclicAcrossPartialResults(stored, proposed, versionIds)) {
            valid = false;
        }
        if (!valid) {
            // Reject every row: an individually successful row must not depend on
            // another row rejected by this trigger or a later validation rule.
            for (Question__c question : incoming) {
                question.addError(INVALID);
            }
        }
    }

    private static Boolean validName(String nodeName) {
        return nodeName != null &&
            NODE_NAME.matcher(nodeName).matches() &&
            !nodeName.toLowerCase().startsWith('xml');
    }

    private static Boolean isSelect(Question__c question) {
        return question.Type__c == 'select_one' ||
            question.Type__c == 'select_multiple';
    }

    private static Boolean validChoiceList(
        Question__c question,
        Map<Id, Choice_List__c> choiceLists
    ) {
        if (question.Choice_List__c == null) {
            return true;
        }
        Choice_List__c choiceList = choiceLists.get(question.Choice_List__c);
        return isSelect(question) &&
            choiceList != null &&
            (choiceList.Owner_Question__c == null ||
            (question.Id != null &&
            choiceList.Owner_Question__c == question.Id));
    }

    private static Boolean validRepeatSettings(Question__c question) {
        if (question.Type__c != 'repeat') {
            return question.Repeat_Mode__c == null &&
                question.Repeat_Count__c == null &&
                question.Repeat_Source_Question__c == null &&
                question.Repeat_Max__c == null &&
                question.Repeat_As_Table__c != true;
        }
        if (question.Repeat_Mode__c == 'fixed') {
            return question.Repeat_Count__c != null &&
                question.Repeat_Source_Question__c == null &&
                (question.Repeat_Max__c == null ||
                question.Repeat_Max__c >= question.Repeat_Count__c);
        }
        if (question.Repeat_Mode__c == 'from_answer') {
            return question.Repeat_Source_Question__c != null &&
                question.Repeat_Count__c == null;
        }
        return question.Repeat_Mode__c == 'open' &&
            question.Repeat_Count__c == null &&
            question.Repeat_Source_Question__c == null;
    }

    private static Boolean validReferences(
        Question__c question,
        Map<Id, Question__c> state,
        Map<Id, Id> formByVersion,
        Boolean validateLineage
    ) {
        if (question.Parent__c != null) {
            Question__c parent = state.get(question.Parent__c);
            if (
                parent == null ||
                question.Id == parent.Id ||
                question.Form_Version__c != parent.Form_Version__c ||
                (parent.Type__c != 'section' &&
                parent.Type__c != 'repeat')
            ) {
                return false;
            }
        }
        if (question.Repeat_Source_Question__c != null) {
            Question__c source = state.get(question.Repeat_Source_Question__c);
            if (
                source == null ||
                question.Id == source.Id ||
                question.Form_Version__c != source.Form_Version__c ||
                source.Type__c != 'integer'
            ) {
                return false;
            }
        }
        if (validateLineage && question.Previous_Version_Question__c != null) {
            Question__c previous = state.get(
                question.Previous_Version_Question__c
            );
            if (
                previous == null ||
                question.Id == previous.Id ||
                question.Form_Version__c == previous.Form_Version__c ||
                formByVersion.get(previous.Form_Version__c) !=
                formByVersion.get(question.Form_Version__c)
            ) {
                return false;
            }
        }
        return true;
    }

    private static Boolean acyclicAcrossPartialResults(
        Map<Id, Question__c> stored,
        Map<Id, Question__c> proposed,
        Set<Id> versionIds
    ) {
        Map<Id, Set<Id>> parents = new Map<Id, Set<Id>>();
        Map<Id, Integer> children = new Map<Id, Integer>();
        for (Question__c question : stored.values()) {
            if (versionIds.contains(question.Form_Version__c)) {
                parents.put(question.Id, new Set<Id>());
                children.put(question.Id, 0);
            }
        }
        for (Id questionId : parents.keySet()) {
            Id oldParent = stored.get(questionId).Parent__c;
            Id newParent = proposed.get(questionId).Parent__c;
            if (oldParent != null && parents.containsKey(oldParent)) {
                parents.get(questionId).add(oldParent);
            }
            if (newParent != null && parents.containsKey(newParent)) {
                parents.get(questionId).add(newParent);
            }
            for (Id parentId : parents.get(questionId)) {
                children.put(parentId, children.get(parentId) + 1);
            }
        }
        List<Id> leaves = new List<Id>();
        for (Id questionId : children.keySet()) {
            if (children.get(questionId) == 0) {
                leaves.add(questionId);
            }
        }
        Integer visited = 0;
        while (visited < leaves.size()) {
            Id questionId = leaves[visited++];
            for (Id parentId : parents.get(questionId)) {
                Integer remaining = children.get(parentId) - 1;
                children.put(parentId, remaining);
                if (remaining == 0) {
                    leaves.add(parentId);
                }
            }
        }
        return visited == parents.size();
    }
}
