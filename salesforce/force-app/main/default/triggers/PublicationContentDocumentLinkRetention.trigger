/** Responsibility: keep each pinned publication artifact linked to its version. */
trigger PublicationContentDocumentLinkRetention on ContentDocumentLink(
  before delete
) {
  PublicationArtifactGuard.protectLinks(Trigger.old);
}
