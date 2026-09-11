# Mobile client boundary

Phase 0 reserves this folder; there is no APK or custom Android application yet.
Use stock ODK Collect when the OpenRosa service exists. The exact supported Collect
release and QR configuration will be recorded before integration.

Brief C11 Phase 6 introduces a Kotlin app on JavaRosa with a task list, record/list
views, device registration and version gating. It must reuse the established sync
contract. Collectors authenticate to Kusanya; no Salesforce user/licence is required.
The browser client is Enketo, not a custom PWA. See ADR 0003.

Original Kusanya mobile code will use the root Apache-2.0 licence. Upstream engine
licences and notices must be reviewed before any source is incorporated.
