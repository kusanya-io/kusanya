/**
 * Responsibility: persist a bounded batch of byte-attested raw submissions and
 * their private Salesforce Files idempotently. This receipt boundary performs no
 * answer parsing, target mapping, Task resolution, media ingestion or remapping.
 */
public with sharing class SubmissionIngestService {
    private static final Integer MAX_BATCH_SIZE = 200;
    private static final Integer MAX_XML_BYTES = 750000;
    private static final Pattern RELAY_ID = Pattern.compile(
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    );
    private static final Pattern INSTANCE_ID = Pattern.compile(
        '^uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );
    private static final Pattern DIGEST = Pattern.compile('^[0-9a-f]{64}$');

    public class Input {
        public String relayId;
        public String formVersionId;
        public String instanceId;
        public String channel;
        public String xmlSha256;
        public String rawXmlBase64;
    }

    public class Outcome {
        public String relayId;
        public String status;
        public String code;

        private Outcome(String relayId, String status, String code) {
            this.relayId = relayId;
            this.status = status;
            this.code = code;
        }
    }

    public class RefusedException extends Exception {
    }

    public static List<Outcome> ingest(List<Input> inputs) {
        if (
            inputs == null ||
            inputs.isEmpty() ||
            inputs.size() > MAX_BATCH_SIZE
        )
            refuse();
        Set<String> relayIds = new Set<String>();
        Set<String> instanceIds = new Set<String>();
        Set<Id> formVersionIds = new Set<Id>();
        Map<String, Input> byInstance = new Map<String, Input>();
        Map<String, Blob> xmlByInstance = new Map<String, Blob>();
        for (Input input : inputs) {
            if (
                input == null ||
                input.relayId == null ||
                !RELAY_ID.matcher(input.relayId).matches()
            )
                refuse();
            if (relayIds.contains(input.relayId))
                refuse();
            relayIds.add(input.relayId);
            if (
                input.instanceId == null ||
                !INSTANCE_ID.matcher(input.instanceId).matches() ||
                instanceIds.contains(input.instanceId) ||
                (input.channel != 'phone' &&
                input.channel != 'web') ||
                input.xmlSha256 == null ||
                !DIGEST.matcher(input.xmlSha256).matches() ||
                String.isBlank(input.rawXmlBase64)
            )
                refuse();
            instanceIds.add(input.instanceId);
            Id formVersionId;
            Blob xml;
            try {
                formVersionId = Id.valueOf(input.formVersionId);
                if (
                    formVersionId.getSObjectType() !=
                    Form_Version__c.SObjectType
                )
                    refuse();
                xml = EncodingUtil.base64Decode(input.rawXmlBase64);
            } catch (Exception error) {
                refuse();
            }
            if (
                xml == null ||
                xml.size() == 0 ||
                xml.size() > MAX_XML_BYTES ||
                EncodingUtil.base64Encode(xml) != input.rawXmlBase64 ||
                EncodingUtil.convertToHex(
                    Crypto.generateDigest('SHA-256', xml)
                ) != input.xmlSha256
            )
                refuse();
            formVersionIds.add(formVersionId);
            byInstance.put(input.instanceId, input);
            xmlByInstance.put(input.instanceId, xml);
        }

        Map<Id, Form_Version__c> versions = new Map<Id, Form_Version__c>(
            [
                SELECT Id, Status__c
                FROM Form_Version__c
                WHERE Id IN :formVersionIds
                WITH USER_MODE
            ]
        );
        if (versions.size() != formVersionIds.size())
            refuse();
        for (Form_Version__c version : versions.values()) {
            if (version.Status__c == 'Draft')
                refuse();
        }

        Map<String, Outcome> outcomes = new Map<String, Outcome>();
        Map<String, Submission__c> existingByInstance = new Map<String, Submission__c>();
        for (Submission__c existing : [
            SELECT
                Id,
                Form_Version__c,
                Instance_Id__c,
                Channel__c,
                XML_Hash__c,
                Status__c,
                Raw_XML_Version__c
            FROM Submission__c
            WHERE Instance_Id__c IN :instanceIds
            WITH USER_MODE
        ]) {
            existingByInstance.put(existing.Instance_Id__c, existing);
        }

        List<Input> fresh = new List<Input>();
        for (Input input : inputs) {
            Submission__c existing = existingByInstance.get(input.instanceId);
            if (existing == null) {
                fresh.add(input);
            } else if (
                String.valueOf(existing.Form_Version__c) !=
                input.formVersionId ||
                existing.Channel__c != input.channel ||
                existing.XML_Hash__c != input.xmlSha256 ||
                String.isBlank(existing.Raw_XML_Version__c)
            ) {
                outcomes.put(
                    input.relayId,
                    new Outcome(input.relayId, 'dead', 'INSTANCE_CONFLICT')
                );
            } else if (
                existing.Status__c == 'Mapped' ||
                existing.Status__c == 'Reprocessed'
            ) {
                outcomes.put(
                    input.relayId,
                    new Outcome(input.relayId, 'mapped', 'ALREADY_MAPPED')
                );
            } else if (existing.Status__c == 'Received') {
                outcomes.put(
                    input.relayId,
                    new Outcome(input.relayId, 'received', 'ALREADY_RECEIVED')
                );
            } else {
                outcomes.put(
                    input.relayId,
                    new Outcome(input.relayId, 'dead', 'SUBMISSION_FAILED')
                );
            }
        }

        if (!fresh.isEmpty()) {
            Savepoint receipt = Database.setSavepoint();
            try {
                List<Submission__c> submissions = new List<Submission__c>();
                for (Input input : fresh) {
                    submissions.add(
                        new Submission__c(
                            Form_Version__c = Id.valueOf(input.formVersionId),
                            Instance_Id__c = input.instanceId,
                            Channel__c = input.channel,
                            Received_At__c = DateTime.now(),
                            XML_Hash__c = input.xmlSha256,
                            Status__c = 'Received',
                            Attempts__c = 0
                        )
                    );
                }
                Database.insert(submissions, true, AccessLevel.USER_MODE);
                List<ContentVersion> files = new List<ContentVersion>();
                for (Integer index = 0; index < fresh.size(); index++) {
                    Input input = fresh[index];
                    files.add(
                        new ContentVersion(
                            Title = 'Kusanya raw submission ' +
                                input.xmlSha256.substring(0, 12),
                            PathOnClient = 'submission.xml',
                            VersionData = xmlByInstance.get(input.instanceId),
                            FirstPublishLocationId = submissions[index].Id
                        )
                    );
                }
                Database.insert(files, true, AccessLevel.USER_MODE);
                for (Integer index = 0; index < fresh.size(); index++) {
                    submissions[index].Raw_XML_Version__c = String.valueOf(
                        files[index].Id
                    );
                }
                Database.update(submissions, true, AccessLevel.USER_MODE);
                for (Input input : fresh) {
                    outcomes.put(
                        input.relayId,
                        new Outcome(input.relayId, 'received', 'RECEIVED')
                    );
                }
            } catch (Exception error) {
                Database.rollback(receipt);
                for (Input input : fresh) {
                    outcomes.put(
                        input.relayId,
                        new Outcome(input.relayId, 'retry', 'RECEIPT_FAILED')
                    );
                }
            }
        }

        List<Outcome> ordered = new List<Outcome>();
        for (Input input : inputs) {
            ordered.add(outcomes.get(input.relayId));
        }
        return ordered;
    }

    private static void refuse() {
        throw new RefusedException('SUBMISSION_INGEST_REFUSED');
    }
}
