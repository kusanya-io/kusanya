/**
 * Responsibility: expose one bounded, integration-only REST boundary for the
 * existing portable definition snapshot reader. It strictly decodes one version
 * identity, returns static non-disclosing failures and never compiles, publishes,
 * reads target data, uploads artifacts or selects credentials.
 */
@RestResource(urlMapping='/v1/publications/definition')
global with sharing class DefinitionSnapshotResource {
    private static final Integer MAX_REQUEST_BYTES = 2048;
    private static final Integer MAX_RESPONSE_BYTES = 5000000;
    @TestVisible
    private static Integer responseByteLimit = MAX_RESPONSE_BYTES;
    private static final Pattern SALESFORCE_ID = Pattern.compile(
        '^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$'
    );
    private static final Set<String> REQUEST_FIELDS = new Set<String>{
        'schemaVersion',
        'formVersionId'
    };

    private class RequestException extends Exception {
    }

    private class RequestEnvelope {
        public String formVersionId;
    }

    @HttpPost
    global static void readDefinition() {
        RestResponse response = RestContext.response;
        response.addHeader('Cache-Control', 'no-store');
        response.addHeader('Content-Type', 'application/json; charset=UTF-8');

        if (!FeatureManagement.checkPermission('Publish_Kusanya')) {
            writeFailure(403, 'DEFINITION_SNAPSHOT_FORBIDDEN');
            return;
        }
        RestRequest request = RestContext.request;
        if (request == null || request.httpMethod != 'POST') {
            writeFailure(405, 'DEFINITION_SNAPSHOT_METHOD');
            return;
        }
        if (!hasJsonMediaType(request)) {
            writeFailure(415, 'DEFINITION_SNAPSHOT_MEDIA_TYPE');
            return;
        }
        if (request.requestBody == null || request.requestBody.size() == 0) {
            writeFailure(400, 'DEFINITION_SNAPSHOT_REFUSED');
            return;
        }
        if (request.requestBody.size() > MAX_REQUEST_BYTES) {
            writeFailure(413, 'DEFINITION_SNAPSHOT_TOO_LARGE');
            return;
        }

        try {
            RequestEnvelope input = decode(request.requestBody.toString());
            Map<String, Object> snapshot = DefinitionSnapshotReader.readVersion(
                parseId(input.formVersionId)
            );
            Blob body = Blob.valueOf(JSON.serialize(snapshot));
            if (body.size() > responseByteLimit) {
                writeFailure(500, 'DEFINITION_SNAPSHOT_FAILED');
                return;
            }
            response.statusCode = 200;
            response.responseBody = body;
        } catch (RequestException error) {
            writeFailure(400, 'DEFINITION_SNAPSHOT_REFUSED');
        } catch (DefinitionSnapshotReader.RefusedException error) {
            writeFailure(400, 'DEFINITION_SNAPSHOT_REFUSED');
        } catch (Exception error) {
            writeFailure(500, 'DEFINITION_SNAPSHOT_FAILED');
        }
    }

    private static RequestEnvelope decode(String body) {
        try {
            JSONParser parser = JSON.createParser(body);
            if (parser.nextToken() != JSONToken.START_OBJECT) {
                refuseRequest();
            }
            RequestEnvelope result = new RequestEnvelope();
            Set<String> seen = new Set<String>();
            while (true) {
                JSONToken token = parser.nextToken();
                if (token == JSONToken.END_OBJECT) {
                    break;
                }
                if (token != JSONToken.FIELD_NAME) {
                    refuseRequest();
                }
                String field = parser.getText();
                if (!REQUEST_FIELDS.contains(field) || seen.contains(field)) {
                    refuseRequest();
                }
                seen.add(field);
                JSONToken valueToken = parser.nextToken();
                if (field == 'schemaVersion') {
                    if (
                        valueToken != JSONToken.VALUE_NUMBER_INT ||
                        parser.getIntegerValue() != 1
                    ) {
                        refuseRequest();
                    }
                } else {
                    if (valueToken != JSONToken.VALUE_STRING) {
                        refuseRequest();
                    }
                    result.formVersionId = parser.getText();
                }
            }
            if (
                seen.size() != REQUEST_FIELDS.size() ||
                parser.nextToken() != null
            ) {
                refuseRequest();
            }
            return result;
        } catch (RequestException error) {
            throw error;
        } catch (Exception error) {
            refuseRequest();
            return null;
        }
    }

    private static Id parseId(String value) {
        if (value == null || !SALESFORCE_ID.matcher(value).matches()) {
            refuseRequest();
        }
        try {
            return Id.valueOf(value);
        } catch (Exception error) {
            refuseRequest();
            return null;
        }
    }

    private static Boolean hasJsonMediaType(RestRequest request) {
        String contentType;
        for (String name : request.headers.keySet()) {
            if (name != null && name.toLowerCase() == 'content-type') {
                contentType = request.headers.get(name);
                break;
            }
        }
        if (contentType == null) {
            return false;
        }
        List<String> parts = contentType.split(';', 2);
        if (parts[0].trim().toLowerCase() != 'application/json') {
            return false;
        }
        return parts.size() == 1 ||
            parts[1].trim().toLowerCase() == 'charset=utf-8';
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

    private static void refuseRequest() {
        throw new RequestException();
    }
}
