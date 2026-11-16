/**
 * Responsibility: expose one bounded integration-only REST receipt for raw
 * submission batches and return fixed per-relay outcomes without record IDs,
 * exception messages, credentials or mapping authority.
 */
@RestResource(urlMapping='/v1/submissions/ingest')
global with sharing class SubmissionIngestResource {
    private static final Integer MAX_REQUEST_BYTES = 1500000;
    @TestVisible
    private static Integer requestByteLimit = MAX_REQUEST_BYTES;

    public class Envelope {
        public Integer schemaVersion;
        public List<SubmissionIngestService.Input> submissions;
    }

    @HttpPost
    global static void ingest() {
        RestContext.response.addHeader('Cache-Control', 'no-store');
        RestContext.response.addHeader(
            'Content-Type',
            'application/json; charset=UTF-8'
        );
        if (!FeatureManagement.checkPermission('Ingest_Kusanya_Submissions')) {
            writeFailure(403, 'SUBMISSION_INGEST_FORBIDDEN');
            return;
        }
        RestRequest request = RestContext.request;
        if (request == null || request.httpMethod != 'POST') {
            writeFailure(405, 'SUBMISSION_INGEST_METHOD');
            return;
        }
        if (!hasJsonMediaType(request)) {
            writeFailure(415, 'SUBMISSION_INGEST_MEDIA_TYPE');
            return;
        }
        if (request.requestBody == null || request.requestBody.size() == 0) {
            writeFailure(400, 'SUBMISSION_INGEST_REFUSED');
            return;
        }
        if (request.requestBody.size() > requestByteLimit) {
            writeFailure(413, 'SUBMISSION_INGEST_TOO_LARGE');
            return;
        }
        try {
            String body = request.requestBody.toString();
            rejectDuplicateKeys(body);
            Envelope input = (Envelope) JSON.deserializeStrict(
                body,
                Envelope.class
            );
            if (input.schemaVersion != 1)
                refuse();
            List<SubmissionIngestService.Outcome> outcomes = SubmissionIngestService.ingest(
                input.submissions
            );
            RestContext.response.statusCode = 200;
            RestContext.response.responseBody = Blob.valueOf(
                JSON.serialize(
                    new Map<String, Object>{
                        'schemaVersion' => 1,
                        'outcomes' => outcomes
                    }
                )
            );
        } catch (Exception error) {
            writeFailure(400, 'SUBMISSION_INGEST_REFUSED');
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

    private static void rejectDuplicateKeys(String body) {
        JSONParser parser = JSON.createParser(body);
        if (parser.nextToken() == null)
            refuse();
        scanValue(parser, 0);
        if (parser.nextToken() != null)
            refuse();
    }

    private static void scanValue(JSONParser parser, Integer depth) {
        if (depth > 8)
            refuse();
        JSONToken token = parser.getCurrentToken();
        if (token == JSONToken.START_OBJECT) {
            Set<String> fields = new Set<String>();
            while (parser.nextToken() != JSONToken.END_OBJECT) {
                if (parser.getCurrentToken() != JSONToken.FIELD_NAME)
                    refuse();
                String field = parser.getText();
                if (fields.contains(field))
                    refuse();
                fields.add(field);
                if (parser.nextToken() == null)
                    refuse();
                scanValue(parser, depth + 1);
            }
        } else if (token == JSONToken.START_ARRAY) {
            while (parser.nextToken() != JSONToken.END_ARRAY) {
                if (parser.getCurrentToken() == null)
                    refuse();
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
            refuse();
        }
    }

    private static void refuse() {
        throw new SubmissionIngestService.RefusedException(
            'SUBMISSION_INGEST_REFUSED'
        );
    }

    private static void writeFailure(Integer statusCode, String code) {
        RestContext.response.statusCode = statusCode;
        RestContext.response.responseBody = Blob.valueOf(
            JSON.serialize(
                new Map<String, Object>{ 'schemaVersion' => 1, 'error' => code }
            )
        );
    }
}
