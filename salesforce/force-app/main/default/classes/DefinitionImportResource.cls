/**
 * Responsibility: expose one bounded, integration-only REST boundary for an
 * atomic draft definition import. It accepts portable authoring identities only,
 * returns one created version identity and never publishes, reads target data,
 * selects credentials or grants collector Salesforce access.
 */
@RestResource(urlMapping='/v1/definitions/import')
global with sharing class DefinitionImportResource {
    private static final Integer MAX_REQUEST_BYTES = 5000000;
    @TestVisible
    private static Integer requestByteLimit = MAX_REQUEST_BYTES;

    @HttpPost
    global static void importDefinition() {
        RestResponse response = RestContext.response;
        response.addHeader('Cache-Control', 'no-store');
        response.addHeader('Content-Type', 'application/json; charset=UTF-8');
        if (!FeatureManagement.checkPermission('Import_Kusanya_Definition')) {
            writeFailure(403, 'DEFINITION_IMPORT_FORBIDDEN');
            return;
        }
        RestRequest request = RestContext.request;
        if (request == null || request.httpMethod != 'POST') {
            writeFailure(405, 'DEFINITION_IMPORT_METHOD');
            return;
        }
        if (!hasJsonMediaType(request)) {
            writeFailure(415, 'DEFINITION_IMPORT_MEDIA_TYPE');
            return;
        }
        if (request.requestBody == null || request.requestBody.size() == 0) {
            writeFailure(400, 'DEFINITION_IMPORT_REFUSED');
            return;
        }
        if (request.requestBody.size() > requestByteLimit) {
            writeFailure(413, 'DEFINITION_IMPORT_TOO_LARGE');
            return;
        }
        try {
            String requestText = request.requestBody.toString();
            rejectDuplicateKeys(requestText);
            DefinitionImportService.ImportEnvelope input = (DefinitionImportService.ImportEnvelope) JSON.deserializeStrict(
                adaptReservedWireKeys(requestText),
                DefinitionImportService.ImportEnvelope.class
            );
            Id versionId = DefinitionImportService.importDefinition(input);
            JSONGenerator output = JSON.createGenerator(false);
            output.writeStartObject();
            output.writeNumberField('schemaVersion', 1);
            output.writeStringField('formVersionId', String.valueOf(versionId));
            output.writeEndObject();
            response.statusCode = 201;
            response.responseBody = Blob.valueOf(output.getAsString());
        } catch (Exception error) {
            writeFailure(400, 'DEFINITION_IMPORT_REFUSED');
        }
    }

    private static String adaptReservedWireKeys(String body) {
        Map<String, Object> envelope = (Map<String, Object>) JSON.deserializeUntyped(
            body
        );
        Map<String, Object> definition = (Map<String, Object>) envelope.get(
            'definition'
        );
        List<Object> questions = (List<Object>) definition.get('questions');
        for (Object value : questions) {
            moveWireKey((Map<String, Object>) value, 'hint', 'hintValue');
        }
        List<Object> rules = (List<Object>) definition.get('skipRules');
        for (Object value : rules) {
            moveWireKey((Map<String, Object>) value, 'join', 'joinValue');
        }
        return JSON.serialize(envelope);
    }

    private static void moveWireKey(
        Map<String, Object> record,
        String wireName,
        String internalName
    ) {
        if (record.containsKey(internalName))
            refuseJson();
        if (record.containsKey(wireName)) {
            record.put(internalName, record.get(wireName));
            record.remove(wireName);
        }
    }

    private static void rejectDuplicateKeys(String body) {
        JSONParser parser = JSON.createParser(body);
        if (parser.nextToken() == null)
            refuseJson();
        scanValue(parser, 0);
        if (parser.nextToken() != null)
            refuseJson();
    }

    private static void scanValue(JSONParser parser, Integer depth) {
        if (depth > 16)
            refuseJson();
        JSONToken token = parser.getCurrentToken();
        if (token == JSONToken.START_OBJECT) {
            Set<String> fields = new Set<String>();
            while (parser.nextToken() != JSONToken.END_OBJECT) {
                if (parser.getCurrentToken() != JSONToken.FIELD_NAME)
                    refuseJson();
                String field = parser.getText();
                if (fields.contains(field))
                    refuseJson();
                fields.add(field);
                if (parser.nextToken() == null)
                    refuseJson();
                scanValue(parser, depth + 1);
            }
        } else if (token == JSONToken.START_ARRAY) {
            while (parser.nextToken() != JSONToken.END_ARRAY) {
                if (parser.getCurrentToken() == null)
                    refuseJson();
                scanValue(parser, depth + 1);
            }
        } else if (
            token != JSONToken.VALUE_STRING &&
            token != JSONToken.VALUE_NUMBER_INT &&
            token != JSONToken.VALUE_NUMBER_FLOAT &&
            token != JSONToken.VALUE_TRUE &&
            token != JSONToken.VALUE_FALSE &&
            token != JSONToken.VALUE_NULL
        ) {
            refuseJson();
        }
    }

    private static void refuseJson() {
        throw new DefinitionImportService.RefusedException(
            'DEFINITION_IMPORT_REFUSED'
        );
    }

    private static Boolean hasJsonMediaType(RestRequest request) {
        String contentType;
        for (String name : request.headers.keySet()) {
            if (name != null && name.toLowerCase() == 'content-type') {
                contentType = request.headers.get(name);
                break;
            }
        }
        if (contentType == null)
            return false;
        List<String> parts = contentType.split(';', 2);
        return parts[0].trim().toLowerCase() == 'application/json' &&
            (parts.size() == 1 ||
            parts[1].trim().toLowerCase() == 'charset=utf-8');
    }

    private static void writeFailure(Integer statusCode, String code) {
        JSONGenerator output = JSON.createGenerator(false);
        output.writeStartObject();
        output.writeNumberField('schemaVersion', 1);
        output.writeStringField('error', code);
        output.writeEndObject();
        RestContext.response.statusCode = statusCode;
        RestContext.response.responseBody = Blob.valueOf(output.getAsString());
    }
}
