/**
 * Responsibility: expose one bounded, integration-only REST boundary for the
 * existing atomic publication lifecycle. It strictly decodes a versioned JSON
 * envelope, returns static non-disclosing failures and never uploads artifacts,
 * selects credentials or claims that the supplied digest attests stored bytes.
 */
@RestResource(urlMapping='/v1/publications/commit')
global with sharing class PublicationCommitResource {
    private static final Integer MAX_REQUEST_BYTES = 200000;
    private static final Pattern SALESFORCE_ID = Pattern.compile(
        '^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$'
    );
    private static final Set<String> REQUEST_FIELDS = new Set<String>{
        'schemaVersion',
        'formVersionId',
        'publicationDigest',
        'xformVersionId',
        'xlsformVersionId',
        'compileWarnings'
    };

    private class RequestException extends Exception {
    }

    private class RequestEnvelope {
        public String formVersionId;
        public String publicationDigest;
        public String xformVersionId;
        public String xlsformVersionId;
        public String compileWarnings;
    }

    @HttpPost
    global static void publish() {
        RestResponse response = RestContext.response;
        response.addHeader('Cache-Control', 'no-store');
        response.addHeader('Content-Type', 'application/json; charset=UTF-8');

        if (!FeatureManagement.checkPermission('Publish_Kusanya')) {
            writeFailure(403, 'PUBLICATION_COMMIT_FORBIDDEN');
            return;
        }
        RestRequest request = RestContext.request;
        if (request == null || request.httpMethod != 'POST') {
            writeFailure(405, 'PUBLICATION_COMMIT_METHOD');
            return;
        }
        if (!hasJsonMediaType(request)) {
            writeFailure(415, 'PUBLICATION_COMMIT_MEDIA_TYPE');
            return;
        }
        if (request.requestBody == null || request.requestBody.size() == 0) {
            writeFailure(400, 'PUBLICATION_COMMIT_REFUSED');
            return;
        }
        if (request.requestBody.size() > MAX_REQUEST_BYTES) {
            writeFailure(413, 'PUBLICATION_COMMIT_TOO_LARGE');
            return;
        }

        try {
            RequestEnvelope input = decode(request.requestBody.toString());
            PublicationLifecycle.Result result = PublicationLifecycle.commitPublication(
                parseId(input.formVersionId),
                input.publicationDigest,
                parseId(input.xformVersionId),
                parseId(input.xlsformVersionId),
                input.compileWarnings
            );
            JSONGenerator output = JSON.createGenerator(false);
            output.writeStartObject();
            output.writeNumberField('schemaVersion', 1);
            output.writeBooleanField(
                'alreadyCommitted',
                result.alreadyCommitted
            );
            output.writeStringField(
                'publicationDigest',
                result.publicationDigest
            );
            output.writeEndObject();
            response.statusCode = 200;
            response.responseBody = Blob.valueOf(output.getAsString());
        } catch (RequestException error) {
            writeFailure(400, 'PUBLICATION_COMMIT_REFUSED');
        } catch (PublicationLifecycle.RefusedException error) {
            writeFailure(400, 'PUBLICATION_COMMIT_REFUSED');
        } catch (Exception error) {
            writeFailure(500, 'PUBLICATION_COMMIT_FAILED');
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
                } else if (field == 'compileWarnings') {
                    if (valueToken == JSONToken.VALUE_NULL) {
                        result.compileWarnings = null;
                    } else if (valueToken == JSONToken.VALUE_STRING) {
                        result.compileWarnings = parser.getText();
                    } else {
                        refuseRequest();
                    }
                } else {
                    if (valueToken != JSONToken.VALUE_STRING) {
                        refuseRequest();
                    }
                    String value = parser.getText();
                    if (field == 'formVersionId') {
                        result.formVersionId = value;
                    } else if (field == 'publicationDigest') {
                        result.publicationDigest = value;
                    } else if (field == 'xformVersionId') {
                        result.xformVersionId = value;
                    } else if (field == 'xlsformVersionId') {
                        result.xlsformVersionId = value;
                    }
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
