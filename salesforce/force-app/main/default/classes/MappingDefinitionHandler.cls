/**
 * Responsibility: keep stored target mapping identifiers and dependency graphs consistent.
 * Trigger-only, without sharing so hidden definitions cannot evade integrity checks.
 * Version and referenced-record locks serialize definition writers; old/new parent
 * edges deliberately reject changes that could cycle under partial DML outcomes.
 * Does not resolve target schema, authorize target access, compile or write targets.
 */
public without sharing class MappingDefinitionHandler {
    private static final Pattern API_IDENTIFIER = Pattern.compile(
        '^[A-Za-z][A-Za-z0-9]*(?:_{1,2}[A-Za-z0-9]+)*$'
    );
    private static final String INVALID = 'Mapping definition is inconsistent. Check identifiers, kind, repeat scope and parent dependencies; stage dependent changes separately.';

    public static void validateMappings(
        List<Mapping__c> incoming,
        Map<Id, Mapping__c> original
    ) {
        Set<Id> versionIds = new Set<Id>();
        Set<Id> parentIds = new Set<Id>();
        Set<Id> repeatIds = new Set<Id>();
        for (Mapping__c definition : incoming) {
            versionIds.add(definition.Form_Version__c);
            parentIds.add(definition.Parent_Mapping__c);
            repeatIds.add(definition.Repeat_Question__c);
        }
        versionIds.remove(null);
        parentIds.remove(null);
        repeatIds.remove(null);
        Map<Id, Form_Version__c> versions = new Map<Id, Form_Version__c>(
            [SELECT Id FROM Form_Version__c WHERE Id IN :versionIds FOR UPDATE]
        );
        Map<Id, Mapping__c> stored = new Map<Id, Mapping__c>(
            [
                SELECT Id, Form_Version__c, Parent_Mapping__c
                FROM Mapping__c
                WHERE Form_Version__c IN :versionIds OR Id IN :parentIds
                FOR UPDATE
            ]
        );
        Map<Id, Question__c> repeats = new Map<Id, Question__c>(
            [
                SELECT Id, Form_Version__c, Type__c
                FROM Question__c
                WHERE Id IN :repeatIds
                FOR UPDATE
            ]
        );
        Map<Id, Mapping__c> proposed = stored.clone();
        for (Mapping__c definition : incoming) {
            if (definition.Id != null) {
                proposed.put(definition.Id, definition);
            }
        }
        Boolean valid = true;
        for (Mapping__c definition : incoming) {
            if (
                String.isBlank(definition.Name) ||
                !versions.containsKey(definition.Form_Version__c) ||
                (original != null &&
                original.get(definition.Id).Form_Version__c !=
                definition.Form_Version__c) ||
                !validIdentifiers(definition) ||
                !validKind(definition, repeats) ||
                !validParent(definition, stored) ||
                !validParent(definition, proposed) ||
                definition.Order__c == null ||
                definition.Order__c <= 0 ||
                definition.Order__c != definition.Order__c.setScale(0)
            ) {
                valid = false;
            }
        }
        if (!acyclicAcrossPartialResults(stored, proposed, versionIds)) {
            valid = false;
        }
        if (!valid) {
            for (Mapping__c definition : incoming) {
                definition.addError(INVALID);
            }
        }
    }

    public static void validateDeletion(Map<Id, Mapping__c> deleting) {
        Set<Id> deletingIds = deleting.keySet();
        List<Mapping__c> outsideDependants = [
            SELECT Id
            FROM Mapping__c
            WHERE Parent_Mapping__c IN :deletingIds AND Id NOT IN :deletingIds
            LIMIT 1
        ];
        if (!outsideDependants.isEmpty()) {
            for (Mapping__c definition : deleting.values()) {
                definition.addError(
                    'Cannot delete mappings referenced by mappings outside this delete batch.'
                );
            }
        }
    }

    private static Boolean validIdentifiers(Mapping__c definition) {
        if (!validIdentifier(definition.Target_Object__c)) {
            return false;
        }
        for (
            String identifier : new List<String>{
                definition.Record_Type__c,
                definition.Parent_Lookup_Field__c,
                definition.Matching_Field__c,
                definition.Upsert_External_Id_Field__c,
                definition.Collector_Field__c,
                definition.Submission_Field__c
            }
        ) {
            if (identifier != null && !validIdentifier(identifier)) {
                return false;
            }
        }
        return true;
    }

    private static Boolean validIdentifier(String identifier) {
        return identifier != null &&
            API_IDENTIFIER.matcher(identifier).matches();
    }

    private static Boolean validKind(
        Mapping__c definition,
        Map<Id, Question__c> repeats
    ) {
        if (definition.Kind__c == 'repeat') {
            Question__c repeat = repeats.get(definition.Repeat_Question__c);
            return repeat != null &&
                repeat.Type__c == 'repeat' &&
                repeat.Form_Version__c == definition.Form_Version__c &&
                definition.Matching_Field__c == null;
        }
        if (definition.Repeat_Question__c != null) {
            return false;
        }
        if (definition.Kind__c == 'reference') {
            return validIdentifier(definition.Matching_Field__c);
        }
        return definition.Kind__c == 'main' &&
            definition.Matching_Field__c == null;
    }

    private static Boolean validParent(
        Mapping__c definition,
        Map<Id, Mapping__c> state
    ) {
        if (definition.Parent_Mapping__c == null) {
            return definition.Parent_Lookup_Field__c == null;
        }
        Mapping__c parent = state.get(definition.Parent_Mapping__c);
        return parent != null &&
            parent.Id != definition.Id &&
            parent.Form_Version__c == definition.Form_Version__c &&
            validIdentifier(definition.Parent_Lookup_Field__c);
    }

    private static Boolean acyclicAcrossPartialResults(
        Map<Id, Mapping__c> stored,
        Map<Id, Mapping__c> proposed,
        Set<Id> versionIds
    ) {
        Map<Id, Set<Id>> parents = new Map<Id, Set<Id>>();
        Map<Id, Integer> children = new Map<Id, Integer>();
        for (Mapping__c definition : stored.values()) {
            if (versionIds.contains(definition.Form_Version__c)) {
                parents.put(definition.Id, new Set<Id>());
                children.put(definition.Id, 0);
            }
        }
        for (Id mappingId : parents.keySet()) {
            Id oldParent = stored.get(mappingId).Parent_Mapping__c;
            Id newParent = proposed.get(mappingId).Parent_Mapping__c;
            if (oldParent != null && parents.containsKey(oldParent)) {
                parents.get(mappingId).add(oldParent);
            }
            if (newParent != null && parents.containsKey(newParent)) {
                parents.get(mappingId).add(newParent);
            }
            for (Id parentId : parents.get(mappingId)) {
                children.put(parentId, children.get(parentId) + 1);
            }
        }
        List<Id> leaves = new List<Id>();
        for (Id mappingId : children.keySet()) {
            if (children.get(mappingId) == 0) {
                leaves.add(mappingId);
            }
        }
        Integer visited = 0;
        while (visited < leaves.size()) {
            Id mappingId = leaves[visited++];
            for (Id parentId : parents.get(mappingId)) {
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
