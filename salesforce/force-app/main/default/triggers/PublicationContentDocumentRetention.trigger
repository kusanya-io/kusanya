/** Responsibility: prevent deletion of a document containing a pinned artifact. */
trigger PublicationContentDocumentRetention on ContentDocument(before delete) {
  PublicationArtifactGuard.protectDocuments(Trigger.old);
}
