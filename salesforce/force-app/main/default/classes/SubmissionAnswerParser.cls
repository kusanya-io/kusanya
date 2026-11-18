/**
 * Responsibility: normalize one bounded raw XForm instance into auditable
 * Answer records without executing customer-object mappings or media writes.
 */
public inherited sharing class SubmissionAnswerParser {
    private static final Integer MAX_ANSWERS = 8000;
    private static final Integer MAX_DEPTH = 32;
    private static final Integer MAX_REPEAT_COUNT = 1000;
    private static final Integer MAX_WARNING_NAMES = 50;
    private static final String ROOT_PARENT_KEY = '#ROOT#';

    public class ParseException extends Exception {
    }

    private class ParsedNode {
        String name;
        String value;
        Question__c question;
        ParsedNode parent;
        List<ParsedNode> children = new List<ParsedNode>();
        Map<Id, Integer> repeatContext = new Map<Id, Integer>();
        String repeatPath = '';
        Integer repeatIndex;
    }

    private class PendingAnswer {
        ParsedNode node;
        PendingAnswer parent;
        Answer__c record;
        Integer depth;
    }

    private class ParseState {
        Id submissionId;
        Id formVersionId;
        Map<Id, Question__c> questionsById;
        Map<String, Question__c> questionsByPlacement;
        Map<String, Question__c> questionsByName;
        Map<Id, List<Id>> repeatAncestors;
        Map<String, List<Question__c>> repeatChildrenByParent;
        Map<String, List<String>> leafValues = new Map<String, List<String>>();
        List<String> warningNames = new List<String>();
        Integer nodeCount = 0;
        ParsedNode root;
    }

    /** Store answers once; Parsed At is the idempotency marker. */
    public static Set<Id> store(Map<Id, Blob> xmlBySubmission) {
        try {
            return storeUnsafe(xmlBySubmission);
        } catch (ParseException error) {
            throw error;
        } catch (Exception error) {
            throw new ParseException('SUBMISSION_PARSE_FAILED');
        }
    }

    private static Set<Id> storeUnsafe(Map<Id, Blob> xmlBySubmission) {
        if (
            xmlBySubmission == null ||
            xmlBySubmission.isEmpty() ||
            xmlBySubmission.size() > 200 ||
            xmlBySubmission.containsKey(null)
        )
            refuse();

        Map<Id, Submission__c> submissions = new Map<Id, Submission__c>(
            [
                SELECT Id, Form_Version__c, Parsed_At__c, Attempts__c
                FROM Submission__c
                WHERE Id IN :xmlBySubmission.keySet()
                WITH USER_MODE
                FOR UPDATE
            ]
        );
        if (submissions.size() != xmlBySubmission.size())
            refuse();
        Set<Id> rejected = new Set<Id>();
        Set<Id> pendingSubmissionIds = new Set<Id>();
        Set<Id> versionIds = new Set<Id>();
        for (Submission__c submission : submissions.values()) {
            if (submission.Parsed_At__c == null) {
                pendingSubmissionIds.add(submission.Id);
                versionIds.add(submission.Form_Version__c);
            }
        }
        if (pendingSubmissionIds.isEmpty())
            return rejected;

        for (AggregateResult count : [
            SELECT Submission__c owner, COUNT(Id) rows
            FROM Answer__c
            WHERE Submission__c IN :pendingSubmissionIds
            WITH USER_MODE
            GROUP BY Submission__c
        ]) {
            if ((Integer) count.get('rows') > 0)
                rejected.add((Id) count.get('owner'));
        }
        pendingSubmissionIds.removeAll(rejected);
        if (pendingSubmissionIds.isEmpty())
            return rejected;

        Map<Id, Map<Id, Question__c>> questionsByVersion = new Map<Id, Map<Id, Question__c>>();
        for (Question__c question : [
            SELECT
                Id,
                Form_Version__c,
                Parent__c,
                Name,
                Type__c,
                Choice_List__c,
                Repeat_Mode__c,
                Repeat_Max__c,
                Repeat_Source_Question__c,
                Order__c
            FROM Question__c
            WHERE Form_Version__c IN :versionIds
            WITH USER_MODE
            ORDER BY Form_Version__c, Order__c, Id
        ]) {
            if (!questionsByVersion.containsKey(question.Form_Version__c))
                questionsByVersion.put(
                    question.Form_Version__c,
                    new Map<Id, Question__c>()
                );
            questionsByVersion.get(question.Form_Version__c)
                .put(question.Id, question);
        }

        List<ParseState> states = new List<ParseState>();
        Set<Id> choiceListIds = new Set<Id>();
        for (Id submissionId : pendingSubmissionIds) {
            try {
                Submission__c submission = submissions.get(submissionId);
                Blob xml = xmlBySubmission.get(submissionId);
                if (xml == null || xml.size() == 0 || xml.size() > 750000)
                    refuse();
                ParseState state = buildState(
                    submission,
                    questionsByVersion.get(submission.Form_Version__c)
                );
                for (Question__c question : state.questionsById.values()) {
                    if (question.Choice_List__c != null)
                        choiceListIds.add(question.Choice_List__c);
                }
                String xmlText;
                try {
                    xmlText = xml.toString();
                } catch (Exception error) {
                    refuse();
                }
                String upper = xmlText.toUpperCase();
                if (upper.contains('<!DOCTYPE') || upper.contains('<!ENTITY'))
                    refuse();
                Dom.Document document = new Dom.Document();
                try {
                    document.load(xmlText);
                } catch (Exception error) {
                    refuse();
                }
                Dom.XmlNode rootXml = document.getRootElement();
                if (rootXml == null)
                    refuse();
                ParsedNode root = new ParsedNode();
                root.name = rootXml.getName();
                indexChildren(
                    rootXml,
                    root,
                    null,
                    new Map<Id, Integer>(),
                    true,
                    state,
                    0
                );
                normalizeRepeats(root, state, 0);
                state.root = root;
                states.add(state);
            } catch (ParseException error) {
                rejected.add(submissionId);
            }
        }

        Map<String, Id> choices = new Map<String, Id>();
        if (!choiceListIds.isEmpty()) {
            for (Choice__c choice : [
                SELECT Id, Choice_List__c, Value__c
                FROM Choice__c
                WHERE Choice_List__c IN :choiceListIds
                WITH USER_MODE
            ]) {
                choices.put(
                    choiceKey(choice.Choice_List__c, choice.Value__c),
                    choice.Id
                );
            }
        }

        List<PendingAnswer> pending = new List<PendingAnswer>();
        Integer maximumDepth = 0;
        List<ParseState> acceptedStates = new List<ParseState>();
        for (ParseState state : states) {
            try {
                List<PendingAnswer> statePending = new List<PendingAnswer>();
                Integer stateMaximumDepth = 0;
                for (ParsedNode child : state.root.children) {
                    stateMaximumDepth = Math.max(
                        stateMaximumDepth,
                        flatten(child, null, 0, state, choices, statePending)
                    );
                }
                if (pending.size() + statePending.size() > MAX_ANSWERS)
                    refuse();
                pending.addAll(statePending);
                maximumDepth = Math.max(maximumDepth, stateMaximumDepth);
                acceptedStates.add(state);
            } catch (ParseException error) {
                rejected.add(state.submissionId);
            }
        }
        states = acceptedStates;

        for (Integer depth = 0; depth <= maximumDepth; depth++) {
            List<Answer__c> level = new List<Answer__c>();
            for (PendingAnswer answer : pending) {
                if (answer.depth != depth)
                    continue;
                if (answer.parent != null) {
                    if (answer.parent.record.Id == null)
                        refuse();
                    answer.record.Parent_Answer__c = answer.parent.record.Id;
                }
                level.add(answer.record);
            }
            if (!level.isEmpty())
                Database.insert(level, true, AccessLevel.USER_MODE);
        }

        List<Error_Log__c> warnings = new List<Error_Log__c>();
        DateTime parsedAt = DateTime.now();
        List<Submission__c> updates = new List<Submission__c>();
        for (ParseState state : states) {
            Submission__c source = submissions.get(state.submissionId);
            if (!state.warningNames.isEmpty()) {
                warnings.add(
                    new Error_Log__c(
                        Submission__c = state.submissionId,
                        Attempt__c = source.Attempts__c == null
                            ? 1
                            : source.Attempts__c + 1,
                        Stage__c = 'parse',
                        Error_Code__c = 'UNKNOWN_NODE',
                        Occurred_At__c = parsedAt,
                        Detail__c = warningDetail(state.warningNames)
                    )
                );
            }
            updates.add(
                new Submission__c(
                    Id = state.submissionId,
                    Parsed_At__c = parsedAt
                )
            );
        }
        if (!warnings.isEmpty())
            Database.insert(warnings, true, AccessLevel.USER_MODE);
        if (!updates.isEmpty())
            Database.update(updates, true, AccessLevel.USER_MODE);
        return rejected;
    }

    private static ParseState buildState(
        Submission__c submission,
        Map<Id, Question__c> questions
    ) {
        ParseState state = new ParseState();
        state.submissionId = submission.Id;
        state.formVersionId = submission.Form_Version__c;
        state.questionsById = questions == null
            ? new Map<Id, Question__c>()
            : questions;
        state.questionsByPlacement = new Map<String, Question__c>();
        state.questionsByName = new Map<String, Question__c>();
        state.repeatAncestors = new Map<Id, List<Id>>();
        state.repeatChildrenByParent = new Map<String, List<Question__c>>();
        for (Question__c question : state.questionsById.values()) {
            String placement = placementKey(question.Parent__c, question.Name);
            if (
                String.isBlank(question.Name) ||
                state.questionsByPlacement.containsKey(placement) ||
                state.questionsByName.containsKey(question.Name)
            )
                refuse();
            state.questionsByPlacement.put(placement, question);
            state.questionsByName.put(question.Name, question);
            if (question.Type__c == 'repeat') {
                String parentKey = question.Parent__c == null
                    ? ROOT_PARENT_KEY
                    : String.valueOf(question.Parent__c);
                if (!state.repeatChildrenByParent.containsKey(parentKey))
                    state.repeatChildrenByParent.put(
                        parentKey,
                        new List<Question__c>()
                    );
                state.repeatChildrenByParent.get(parentKey).add(question);
            }
        }
        for (Question__c question : state.questionsById.values()) {
            state.repeatAncestors.put(
                question.Id,
                repeatAncestors(question, state.questionsById, new Set<Id>())
            );
        }
        return state;
    }

    private static List<Id> repeatAncestors(
        Question__c question,
        Map<Id, Question__c> questions,
        Set<Id> visiting
    ) {
        if (question.Parent__c == null)
            return new List<Id>();
        if (visiting.contains(question.Id))
            refuse();
        visiting.add(question.Id);
        Question__c parent = questions.get(question.Parent__c);
        if (parent == null)
            refuse();
        List<Id> result = repeatAncestors(parent, questions, visiting);
        if (parent.Type__c == 'repeat')
            result.add(parent.Id);
        visiting.remove(question.Id);
        return result;
    }

    private static void indexChildren(
        Dom.XmlNode xmlParent,
        ParsedNode parsedParent,
        Id expectedParentId,
        Map<Id, Integer> context,
        Boolean knownScope,
        ParseState state,
        Integer depth
    ) {
        if (depth > MAX_DEPTH)
            refuse();
        Set<Id> singletons = new Set<Id>();
        Map<Id, Integer> repeatOrdinals = new Map<Id, Integer>();
        for (Dom.XmlNode xmlChild : xmlParent.getChildElements()) {
            String name = xmlChild.getName();
            if (name == null || name.length() > 128)
                refuse();
            if (
                depth == 0 &&
                (name == 'meta' || name.startsWith('_ksny_count_'))
            )
                continue;
            if (name.startsWith('_ksny_count_'))
                continue;
            Question__c question = knownScope
                ? state.questionsByPlacement.get(
                      placementKey(expectedParentId, name)
                  )
                : null;
            if (
                knownScope &&
                question == null &&
                state.questionsByName.containsKey(name)
            )
                refuse();
            ParsedNode parsed = new ParsedNode();
            parsed.name = name;
            parsed.question = question;
            parsed.parent = parsedParent;
            parsed.repeatContext.putAll(context);
            parsed.repeatPath = parsedParent.repeatPath;
            parsed.repeatIndex = parsedParent.repeatIndex;
            state.nodeCount++;
            if (state.nodeCount > MAX_ANSWERS)
                refuse();

            Boolean container =
                question != null &&
                (question.Type__c == 'section' ||
                question.Type__c == 'repeat');
            List<Dom.XmlNode> elementChildren = xmlChild.getChildElements();
            if (question != null && container != !elementChildren.isEmpty()) {
                if (!(container && elementChildren.isEmpty()))
                    refuse();
            }
            if (question != null && question.Type__c == 'repeat') {
                Integer ordinal = repeatOrdinals.containsKey(question.Id)
                    ? repeatOrdinals.get(question.Id) + 1
                    : 1;
                repeatOrdinals.put(question.Id, ordinal);
                parsed.repeatContext.put(question.Id, ordinal);
                parsed.repeatIndex = ordinal;
                parsed.repeatPath += '/' + name + '[' + ordinal + ']';
            } else if (question != null) {
                if (singletons.contains(question.Id))
                    refuse();
                singletons.add(question.Id);
            }

            if (question == null) {
                addWarning(state, name);
            }
            if (elementChildren.isEmpty()) {
                parsed.value = xmlChild.getText();
                if (parsed.value == null)
                    parsed.value = '';
                if (parsed.value.length() > 32768)
                    refuse();
                if (question != null) {
                    String key = contextKey(
                        question,
                        parsed.repeatContext,
                        state
                    );
                    List<String> values = state.leafValues.get(key);
                    if (values == null) {
                        values = new List<String>();
                        state.leafValues.put(key, values);
                    }
                    values.add(parsed.value);
                }
            } else {
                indexChildren(
                    xmlChild,
                    parsed,
                    question == null ? null : question.Id,
                    parsed.repeatContext,
                    knownScope && question != null,
                    state,
                    depth + 1
                );
            }
            parsedParent.children.add(parsed);
        }
    }

    private static void normalizeRepeats(
        ParsedNode parent,
        ParseState state,
        Integer depth
    ) {
        if (depth > MAX_DEPTH)
            refuse();
        Map<Id, List<ParsedNode>> repeats = new Map<Id, List<ParsedNode>>();
        for (ParsedNode child : parent.children) {
            if (child.question != null && child.question.Type__c == 'repeat') {
                if (!repeats.containsKey(child.question.Id))
                    repeats.put(child.question.Id, new List<ParsedNode>());
                repeats.get(child.question.Id).add(child);
            }
        }
        Set<ParsedNode> excluded = new Set<ParsedNode>();
        String parentKey = parent.parent == null
            ? ROOT_PARENT_KEY
            : parent.question == null
                  ? null
                  : String.valueOf(parent.question.Id);
        List<Question__c> repeatDefinitions = parentKey == null
            ? null
            : state.repeatChildrenByParent.get(parentKey);
        if (repeatDefinitions == null)
            repeatDefinitions = new List<Question__c>();
        for (Question__c repeat : repeatDefinitions) {
            if (repeat.Repeat_Mode__c != 'from_answer')
                continue;
            List<ParsedNode> instances = repeats.get(repeat.Id);
            if (instances == null)
                instances = new List<ParsedNode>();
            Question__c source = state.questionsById.get(
                repeat.Repeat_Source_Question__c
            );
            if (source == null)
                refuse();
            List<String> submitted = state.leafValues.get(
                contextKey(source, parent.repeatContext, state)
            );
            if (submitted == null || submitted.size() != 1)
                refuse();
            String raw = submitted[0];
            if (!Pattern.matches('^(?:0|[1-9][0-9]*)$', raw))
                refuse();
            Integer count;
            try {
                count = Integer.valueOf(raw);
            } catch (Exception error) {
                refuse();
                return;
            }
            Integer ceiling = repeat.Repeat_Max__c == null
                ? MAX_REPEAT_COUNT
                : repeat.Repeat_Max__c.intValue();
            if (count > ceiling || instances.size() < count)
                refuse();
            for (Integer index = count; index < instances.size(); index++)
                excluded.add(instances[index]);
        }
        if (!excluded.isEmpty()) {
            List<ParsedNode> retained = new List<ParsedNode>();
            for (ParsedNode child : parent.children) {
                if (!excluded.contains(child))
                    retained.add(child);
            }
            parent.children = retained;
        }
        for (ParsedNode child : parent.children)
            normalizeRepeats(child, state, depth + 1);
    }

    private static Integer flatten(
        ParsedNode node,
        PendingAnswer parent,
        Integer depth,
        ParseState state,
        Map<String, Id> choices,
        List<PendingAnswer> pending
    ) {
        if (depth > MAX_DEPTH || node.repeatPath.length() > 255)
            refuse();
        PendingAnswer item = new PendingAnswer();
        item.node = node;
        item.parent = parent;
        item.depth = depth;
        item.record = new Answer__c(
            Submission__c = state.submissionId,
            Question__c = node.question == null ? null : node.question.Id,
            Node_Name__c = node.name,
            Repeat_Path__c = String.isBlank(node.repeatPath)
                ? null
                : node.repeatPath,
            Repeat_Index__c = node.repeatIndex,
            Value__c = node.value
        );
        projectTypedValue(item.record, node, choices, state);
        pending.add(item);
        if (pending.size() > MAX_ANSWERS)
            refuse();
        Integer maximum = depth;
        for (ParsedNode child : node.children)
            maximum = Math.max(
                maximum,
                flatten(child, item, depth + 1, state, choices, pending)
            );
        return maximum;
    }

    private static void projectTypedValue(
        Answer__c answer,
        ParsedNode node,
        Map<String, Id> choices,
        ParseState state
    ) {
        if (node.question == null || node.value == null || node.value == '')
            return;
        String typeName = node.question.Type__c;
        try {
            if (typeName == 'integer') {
                if (!Pattern.matches('^-?(?:0|[1-9][0-9]{0,11})$', node.value))
                    refuse();
                answer.Numeric_Value__c = Decimal.valueOf(node.value);
            } else if (typeName == 'decimal') {
                if (
                    !Pattern.matches(
                        '^-?(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,6})?$',
                        node.value
                    )
                )
                    refuse();
                answer.Numeric_Value__c = Decimal.valueOf(node.value);
            } else if (typeName == 'date') {
                if (
                    !Pattern.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$', node.value)
                )
                    refuse();
                answer.Date_Value__c = Date.valueOf(node.value);
            } else if (typeName == 'datetime') {
                answer.Datetime_Value__c = (DateTime) JSON.deserialize(
                    JSON.serialize(node.value),
                    DateTime.class
                );
            } else if (
                typeName == 'select_one' &&
                node.question.Choice_List__c != null
            ) {
                Id choiceId = choices.get(
                    choiceKey(node.question.Choice_List__c, node.value)
                );
                if (choiceId == null)
                    addWarning(state, node.name + ':choice');
                else
                    answer.Choice__c = choiceId;
            }
        } catch (ParseException error) {
            throw error;
        } catch (Exception error) {
            refuse();
        }
    }

    private static String contextKey(
        Question__c question,
        Map<Id, Integer> context,
        ParseState state
    ) {
        String key = String.valueOf(question.Id);
        for (Id repeatId : state.repeatAncestors.get(question.Id)) {
            Integer ordinal = context.get(repeatId);
            if (ordinal == null)
                refuse();
            key += ':' + String.valueOf(ordinal);
        }
        return key;
    }

    private static String placementKey(Id parentId, String name) {
        return String.valueOf(parentId) + ':' + name;
    }

    private static String choiceKey(Id listId, String value) {
        return String.valueOf(listId) + ':' + value;
    }

    private static void addWarning(ParseState state, String name) {
        if (
            state.warningNames.size() < MAX_WARNING_NAMES &&
            !state.warningNames.contains(name)
        )
            state.warningNames.add(name);
    }

    private static String warningDetail(List<String> names) {
        String detail =
            'Retained unknown or unmatched nodes: ' + String.join(names, ', ');
        return detail.length() > 32768 ? detail.substring(0, 32768) : detail;
    }

    private static void refuse() {
        throw new ParseException('SUBMISSION_PARSE_FAILED');
    }
}
