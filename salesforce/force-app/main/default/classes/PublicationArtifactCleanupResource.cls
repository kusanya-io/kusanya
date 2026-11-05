/**
 * Responsibility: expose the atomic unlinked-artifact cleanup boundary only to
 * the integration principal. It strictly decodes one versioned envelope and
 * returns fixed, non-disclosing responses.
 */
@RestResource(urlMapping='/v1/publications/artifacts/cleanup')
global with sharing class PublicationArtifactCleanupResource {
    private static final Integer MAX_REQUEST_BYTES = 4096;
    private static final Pattern SALESFORCE_ID = Pattern.compile(
        '^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$'
    );
    private static final Set<String> REQUEST_FIELDS = new Set<String>{
        'schemaVersion',
        'formVersionId',
        'publicationDigest',
        'xformVersionId',
        'xlsformVersionId'
    };

    private class RequestException extends Exception {
    }

    private class RequestEnvelope {
        public String formVersionId;
        public String publicationDigest;
        public String xformVersionId;
        public String xlsformVersionId;
    }

    @HttpPost
    global static void cleanup() {
        RestResponse response = RestContext.response;
        response.addHeader('Cache-Control', 'no-store');
        response.addHeader('Content-Type', 'application/json; charset=UTF-8');
        if (!FeatureManagement.checkPermission('Publish_Kusanya')) {
            writeFailure(403, 'PUBLICATION_ARTIFACT_CLEANUP_FORBIDDEN');
            return;
        }
        RestRequest request = RestContext.request;
        if (request == null || request.httpMethod != 'POST') {
            writeFailure(405, 'PUBLICATION_ARTIFACT_CLEANUP_METHOD');
            return;
        }
        if (!hasJsonMediaType(request)) {
            writeFailure(415, 'PUBLICATION_ARTIFACT_CLEANUP_MEDIA_TYPE');
            return;
        }
        if (request.requestBody == null || request.requestBody.size() == 0) {
            writeFailure(400, 'PUBLICATION_ARTIFACT_CLEANUP_REFUSED');
            return;
        }
        if (request.requestBody.size() > MAX_REQUEST_BYTES) {
            writeFailure(413, 'PUBLICATION_ARTIFACT_CLEANUP_TOO_LARGE');
            return;
        }
        try {
            RequestEnvelope input = decode(request.requestBody.toString());
            PublicationArtifactCleanup.deleteUnlinkedArtifacts(
                parseId(input.formVersionId),
                input.publicationDigest,
                parseId(input.xformVersionId),
                parseId(input.xlsformVersionId)
            );
            response.statusCode = 200;
            response.responseBody = Blob.valueOf(
                '{"schemaVersion":1,"deleted":true}'
            );
        } catch (RequestException error) {
            writeFailure(400, 'PUBLICATION_ARTIFACT_CLEANUP_REFUSED');
        } catch (PublicationArtifactCleanup.RefusedException error) {
            writeFailure(400, 'PUBLICATION_ARTIFACT_CLEANUP_REFUSED');
        } catch (Exception error) {
            writeFailure(500, 'PUBLICATION_ARTIFACT_CLEANUP_FAILED');
        }
    }

    private static RequestEnvelope decode(String body) {
        try {
            JSONParser parser = JSON.createParser(body);
            if (parser.nextToken() != JSONToken.START_OBJECT)
                refuse();
            RequestEnvelope result = new RequestEnvelope();
            Set<String> seen = new Set<String>();
            while (true) {
                JSONToken token = parser.nextToken();
                if (token == JSONToken.END_OBJECT)
                    break;
                if (token != JSONToken.FIELD_NAME)
                    refuse();
                String field = parser.getText();
                if (!REQUEST_FIELDS.contains(field) || seen.contains(field)) {
                    refuse();
                }
                seen.add(field);
                JSONToken valueToken = parser.nextToken();
                if (field == 'schemaVersion') {
                    if (
                        valueToken != JSONToken.VALUE_NUMBER_INT ||
                        parser.getIntegerValue() != 1
                    )
                        refuse();
                } else {
                    if (valueToken != JSONToken.VALUE_STRING)
                        refuse();
                    String value = parser.getText();
                    if (field == 'formVersionId')
                        result.formVersionId = value;
                    else if (field == 'publicationDigest')
                        result.publicationDigest = value;
                    else if (field == 'xformVersionId')
                        result.xformVersionId = value;
                    else if (field == 'xlsformVersionId')
                        result.xlsformVersionId = value;
                }
            }
            if (
                seen.size() != REQUEST_FIELDS.size() ||
                parser.nextToken() != null
            ) {
                refuse();
            }
            return result;
        } catch (RequestException error) {
            throw error;
        } catch (Exception error) {
            refuse();
            return null;
        }
    }

    private static Id parseId(String value) {
        if (value == null || !SALESFORCE_ID.matcher(value).matches())
            refuse();
        try {
            return Id.valueOf(value);
        } catch (Exception error) {
            refuse();
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
        if (contentType == null)
            return false;
        List<String> parts = contentType.split(';', 2);
        return parts[0].trim().toLowerCase() == 'application/json' &&
            (parts.size() == 1 ||
            parts[1].trim().toLowerCase() == 'charset=utf-8');
    }

    private static void writeFailure(Integer statusCode, String code) {
        RestContext.response.statusCode = statusCode;
        RestContext.response.responseBody = Blob.valueOf(
            '{"schemaVersion":1,"error":"' + code + '"}'
        );
    }

    private static void refuse() {
        throw new RequestException();
    }
}
