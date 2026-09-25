/** Responsibility: prevent deletion of an exact pinned publication artifact. */
trigger PublicationContentVersionRetention on ContentVersion(before delete) {
  PublicationArtifactGuard.protectVersions(Trigger.old);
}
