# Build brief for Codex: Splash's own field data collection tool, replacing TaroWorks

You are the lead engineer building Splash's own replacement for TaroWorks. TaroWorks is a Salesforce-native mobile data collection product: an administrator designs forms in Salesforce, collectors run them offline on Android phones built on the ODK XForms engine, work is assigned as Jobs and Tasks tied to Salesforce records, and every submission is written back into Salesforce as records of any object, with photos and GPS. We have spent September 2026 migrating every Splash instrument onto TaroWorks and we know the product down to its field names. This brief gives you all of it: what the product is, how it is built, every object and field, the lifecycle rules, the defects we hit, the data design we built on top of it, and the specification of the tool you will build. The intention is a complete, self-owned replacement that Splash deploys in its own Salesforce org and runs on its own hosting, with no dependency on TaroWorks or on any vendor form server.

Two design choices define the product and separate it from TaroWorks. First, **collectors never hold a Salesforce licence**: the tool connects to each Salesforce org once, through a connected app as an integration user, and collectors authenticate to the tool, not to Salesforce, which is how FormAssembly and the other connector products work and why they cost nothing per user. Second, **one form runs both offline and online**: the same ODK XForm runs on the phone without signal and in a browser from a shared link, through the open-source Enketo renderer, and both paths submit to the same endpoint and the same mapping. The product is designed from the first commit to serve many Salesforce orgs from one service, even though Splash is the first and only customer for now.

Read the whole brief before writing code. Where it says decide, decide, write a short ADR in `docs/decisions/`, and continue. Where it says ask, stop and ask. The seed material described in section 12 is in `seed/` in this repository; read `seed/_worked_example_HWWS_form_job_submission.json` before anything else, because it is a real form, job and submission from our production org.

Product name: Kusanya (Swahili, to gather). Namespace prefix: `ksny` unless a conflict is found. Owner: Cobitech Solutions; first customer and launch partner: Splash.

---

## Part A. What TaroWorks is, exactly

### A1. The shape of the product

TaroWorks is a managed package (namespace `gfsurveys`, 44 custom objects plus change-event and share shadows) installed into the customer's Salesforce org, an Android app, and a small vendor-hosted service that compiles forms into XForms and relays submissions. Everything an administrator touches lives in Salesforce:

- **Forms** ("Surveys") are records: a Survey with numbered Survey Versions, each version owning a tree of Questions, each Question owning Options and Skip Conditions.
- **Mappings** are records: a Survey Mapping per target object (one for the main record, one per repeat group, plus reference mappings for lookups), each owning Question Mappings (question to field) and Object Relationship Mappings (child to parent lookup).
- **Jobs** are records: a Job Template with a drill-down hierarchy (which records the collector picks from), owning Task Templates (each a form, a record view or a list view, with prefill), and instantiated Jobs and Tasks that record what the collector did and where.
- **Collectors** are Salesforce users (internal or Experience Cloud community users), wrapped by a Mobile User record, assigned to work through Salesforce Queues and Public Groups.
- **Submissions** are records: a Submission per completed form with Answer rows per question per repeat instance, the raw XML hash, start and end times, GPS, and the device.
- **Extras** that Splash does not use but the product ships: scoring groups, the Poverty Probability Index (PPI), performance targets, contact groups and client assignation, mobile money collection, a survey library, application version gating, and an error log.

The phone app logs in through the org's Experience site URL (`https://<mydomain>.my.site.com/taroworks`) with Salesforce credentials, downloads the published forms and the Jobs its user can see, works offline, and syncs. The mapping from submission to records runs inside Salesforce as the submitting user, so the collector's permissions decide what gets created.

### A2. The complete object inventory, as installed in our org

Every field below was read from the org's describe on 10 September 2026 and is in `seed/<object>.json` with types, picklists, references and API writeability. Object names are given without the `gfsurveys__` prefix and fields without the `__c` suffix.

**Form model**

- `Survey`: Name, Status (Draft, Updating, Published, Closed), Version, PublishedDate, Description, Alias, CountryCode, LanguageCode, Deployment (Smartphone), TWFolder (lookup to `TWFolder`), SurveyLibrary, IsTemplate, ParentTemplate, IsCloned, IsPPI, PPIDataYear, PpiIdentifier, AllowAnonymousInterviewee, Close_Message, Password (encrypted), Gps_Location_Enabled, Gps_ShowMap, InterviewMapField, RunHiddenDynamicOperations, Saving_XForm, XForm_Status (NONE, DEFAULT, CUSTOM), RemoteId, RemoteCreatorName, RemoteOrganisation, API_External_Id. Formulas: QuestionCount, ResponseCount, TotalSubmissions, TotalTargets, StatusImage.
- `SurveyVersion`: Survey (master), Version (number), Status (Draft, Deprecated, Invalid, Closed, Published, Updating), Distributed, DistributionDate, CloseReason (Automatically Closed), DisplayScoreOffline, PrintScore, Change_Log, SurveyLibrary. Auto-number Name like `SV-0000000007`.
- `Question`: SurveyVersion, Survey (read only), Parent (self lookup; sections and repeats are questions whose children point at them), Position (order within its parent), Name (the XForm node name, for example `site_name`, `h_mdm_observation_q1`), Caption (the label shown), Hint, Type, Required, Hidden, SamePage (render with the previous question on one screen), Minimum, Maximum, ResponseValidation (a regular expression), ResponseValidationExample, DynamicOperation (JavaScript), DynamicOperationType (Calculation, Validation), Dynamic_Operation_Test_Data, Test_Dynamic_Operations, DoBefore, DoAfter, CurrentTime, ControllingQuestion, SkipLogicBehavior (Show, Hide), SkipLogicOperator (All, Any), RepeatCondition (undetermined, fixed, previews_answer), RepeatTimes, RepeatValue, RepeatSourceValue (the question whose answer sets the repeat count), MaxInstance, IsRepeatInTable, CascadingSelect, CascadingLevel, PpiResultsField, PrintAnswer, IsRemoteEditable, Require_Live_Photo, Preserve_Media_File_After_Upload, Media_Duration_Seconds, Media_Upload_Folder_Link, AllowTapToCaptureGPSCoordinate, AllowSelfIntersectingPolygon, MinimumRequiredArea, MinimumRequiredPerimeter, FromVersion, ToVersion, PreviousVersionQuestion (lineage across versions), RemoteId, RemoteServerId, API_External_Id, SurveyLibrary. Formula IsDraft.
  - Type picklist, verbatim: `section`, `repeat`, `text`, `text-short`, `text-long`, `number`, `number-integer`, `number-decimal`, `date`, `date-date`, `date-datetime`, `radio` (select one), `checkbox` (select many), `static-content` (a note), `end_of_survey`, `barcode`, `gps-location`, `gps-geoshape`, `picture`, `signature`, `video`, `audio`, `file`, `cascading-select`, `cascading-level`.
- `Option`: Question (master), Caption (label), OptionalCode (the stored value; when blank the caption is the value), Position, PPIScore, RemoteId, API_External_Id.
- `SkipCondition`: Parent (the question that is shown or hidden), SourceQuestion (the question whose answer is tested), Condition (Answered, Is, LesserThan, GreaterThan, InRange), Value, SkipValue, Negate, RemoteId, API_External_Id. The Parent question's SkipLogicBehavior says whether matching conditions Show or Hide it, and SkipLogicOperator says whether All or Any must match.
- `CascadingSelect` (Name, Status Processing, Ready, Invalid), `CascadingLevel` (CascadingSelect, Name, Position, ControllingLevel), `CascadingSelectValue` (CascadingLevel, Value, Position, ControllingSelectValue): a static hierarchy such as province, district, school, uploaded as a table and referenced by `cascading-select` and `cascading-level` questions.
- `SurveyLibrary`: a vendor catalogue of template surveys and PPI scorecards (URL, RemoteLibraryPath, SurveyPreviewPath, PpiResultsEndpoint, IsPPI, IsSurvey, IsTemplate, Active).
- `TWFolder`: folders for surveys and job templates.

**Mapping model**

- `SurveyMapping`: SurveyVersion, Survey, ObjectApiName (the target object), Repeat (lookup to the repeat Question; null for the main record), IsReference (true for a lookup-resolution mapping that finds an existing record rather than creating one), MatchingField (the field used to find the referenced record, for example `Name` or `Id`), UseAsInterviewee, IntervieweeApiField, SurveyorApiField (a field on the target that receives the collector), SubmissionApiField (a field that receives the Submission Id), SurveyApiField, SurveyVersionApiField, PPIScoreApiField, API_External_Id. Formula Number_of_Associated_Field_Mappings.
- `QuestionMapping`: SurveyMapping (master), Question, FieldApiName (target field), ScoringGroup, IsBroken (set when the field no longer exists), API_External_Id.
- `ObjectRelationshipMapping`: ChildSurveyMapping, ParentSurveyMapping, FieldApiName (the lookup on the child that receives the parent's Id). Used both for repeat children to their parent record and for the main record to a reference mapping (for example Site Survey to Account).

**Job model**

- `JobTemplate`: Name, Status (Draft, Published, Closed), PublishedDate, CloseReason, Instructions, TWFolder, Hierarchy (JSON, the drill-down), formula TasksNumber (not writeable). Saving a Job Template creates a Salesforce Queue with the template's name that owns the template; `QueueSobject` lists `JobTemplate` as a supported object. Assignment is Queue, then Public Group member of the queue, then users in the group.
- `TaskTemplate`: JobTemplate (master), Position, Type (`form`, `data-view`, `list-view`), Form (lookup to SurveyVersion, not to Survey), Object (for data and list views), ResourceId, Instructions, Mapping (JSON, the prefill).
- `Job`: JobTemplate (master), Mobile_User (User), Contact, Assigned (Contact), CreationSource (Ad-hoc), CreationDate, CreationNotes, StartDate, EndDate, StartLocation and EndLocation (geolocation), JobActivityMD5. A Job row is the collector's execution of a template against one drill-down selection.
- `Task`: TaskTemplate (master), Job, Submission, StartDate, EndDate, StartLocation, EndLocation, TaskActivityMD5.
- `PerformanceTarget` (Type Job_Target or Performance_Indicator, AggregationOperation AVG, COUNT, CUSTOM, PERCENTAGE, SUM, Timeframe Weekly, Monthly, Custom, TrackedSObjectApiName, TrackedFieldApiName, TrackedSObjectContactLookupFieldName, DefaultValue, StartDate, EndDate, Status), `AssignedTarget` (PerformanceTarget, User, Contact, TargetValue, ActualValue, RecordCount, List_View_Name, Status Active, Pending, Closed, formulas Progress and ActualValueResult), `SObjectFilterCondition` (PerformanceTarget, FieldAPIName, Operator, Value): per-collector targets shown on the phone.

**Collector model**

- `TaroWorks_Mobile_User`: the administrator's onboarding object for community-licence collectors. User, Contact, Account (the partner account), Username, Email, First_Name, Last_Name, Alias, Profile (TaroWorks Partner User, TaroWorks User, TaroWorks Customer Community Plus User, System Administrator, Country Report Manager), Profile_Id, Role, Contact_Record_Type, Language, Active, Last_Login, Assigned_Public_Group_IDs and Assigned_Public_Group_Names (text, what the page shows), Assigned_Record_Ids and Assigned_Record_Objects (text, the records assigned for drill-downs), Mobile, Phone, Salutation. Formulas License, Manager, Record_Type, Last_Login_F.
- `Mobile_User`: the runtime login record. User, Contact, Username, Password, Session_Token, Status (Active, Inactive, Blocked), Last_Login, Last_Activity, Last_Device.
- `Device`: Device_Id, IMEI, Model, OS, App_version, Number, Status, LastCheckInBy, LastCheckInDate.
- `ApplicationVersion`: version gating for the app (CompatibleVersion, OldestConfirmedVersion, DownloadURL, IsActive, ReleaseDate); `Compatible_App`.
- `SObjectUserAssociation` and `SObjectContactAssociation`: record assignment. AssociatedIds (a text list of record Ids), SObjectApiName, SObjectFieldApiName (the display field), NumberOfRecords, Instance, UniqueKey (user_level_object). This is what "assign records to a mobile user" writes, and nothing else: it does not create sharing.
- `ContactGroup`, `ContactGroupMember`, `ContactGroupSurveyAssignment` (ContactGroup, Survey, StartDate, EndDate, Target, Remarks): assign a survey to a group of interviewees (clients) for a period, with a target count. `Client_Assignation`.

**Submission model**

- `Submission`: Survey (master), SurveyVersion, Mobile_User (User), Surveyor (Contact), Interviewee (Contact), Assignment (ContactGroupSurveyAssignment), Device, Date, startDate, endDate, gps_x, gps_y, gps_approximation, Status (Uploading, Uploaded, Uploaded After Survey Closed, Uploaded - Processed after Survey Automatically Closed), SubmissionXMLMD5 (hash of the XML, the deduplication key), PPIScore. Formula AnswersCount. Auto-number like `SA-000001`. Media files from picture, signature, audio, video and file questions are stored as Salesforce Files on the Submission record; large images are downsized on sync.
- `Answer`: Submission (master), Question, Value (string), TextValue, TextAreaValue, NumericValue, DateValue, DateTimeValue, Option (lookup when the answer is a choice), Instance (the repeat index, null outside repeats), Parent (the Answer of the enclosing repeat), AnswerKeyMD5.
- `ScoringGroup`, `ScoreValue` (Option to points), `SubmissionScore` (TotalScore per group per submission).
- `PPITable`, `PPITableDataSet`, `PPITableLine`, `PpiResult` (ClientId, Gender, Age, HouseholdSize, JoinedDate, Geolocation, AnswerOne to AnswerTen as Option lookups, PpiScore formula), `SubmissionPPIValue`, `SubmissionPpiAssociation`: the Poverty Probability Index scorecard feature.
- `Mobile_Money_Collection`: an integration for collecting payments in the field (Amount, Currency, Phone_Number, Status successful, failed, pending, cashed_out, Remote_Transaction_ID).
- `TWErrorLog`: ErrorType (Sync, Salesforce, Mobile Money Integration), ErrorCode, ErrorMessage, Object, User.

### A3. Lifecycle rules, as observed in production

1. **Publishing.** A Survey and its version both go to Published with a PublishedDate. Publishing runs hidden vendor Apex that generates the XForm (`Saving_XForm`, `XForm_Status`). Publishing is a UI action; there is no API to trigger it.
2. **Editing a published form.** Edit clones every question, option, skip condition, survey mapping and question mapping into version N+1 with Survey status Updating and Version status Updating. Questions on an Updating version are editable by API. Publish makes N+1 live and retires N (Deprecated). Questions on a Published version are locked with the message 'This question can not be edited: the form is not in Draft status'.
3. **Mappings are editable on a Published version.** Only questions are locked. So field mapping changes never need a new version; wording, hints, options and skip logic do.
4. **Required target fields must all be mapped**, or the Field Mapping page refuses to save. We had to make `Round_Number__c` optional on the target object to map the form.
5. **The reference is a question.** To link a created record to an existing one (the school), the form carries a required `text-short` question (`site_name`) mapped to `Name` on a Survey Mapping with IsReference true, ObjectApiName Account and MatchingField Name; an Object Relationship Mapping from the main mapping to the reference mapping names the lookup field (`Site__c`). The Job prefills the question so the collector never types it. Name matching is only safe while names are unique (341 Zambia schools, 0 duplicates, rechecked when new countries load).
6. **The drill-down is JSON on the Job Template**, verbatim from our Student Job:
   `[[{"listFields":["Name"],"detailFields":["Name","Account_Name_Local_Language__c"],"objectName":"Account","objectId":"mkrs","label":"Sites","drilldownLevel":1,"recordFilter":[{"filterField":"ShippingCountry","operator":"Equals","value":"Zambia"}],"drilldownName":"Select Site (School)"}]]`
   One level, Accounts filtered to Zambia, showing Name and the local-language name. Levels can nest (for example school then classroom).
7. **The prefill is JSON on the Task Template**, verbatim: `[{"objectId":"mkrs","field":"Name","question":"site_name","drilldownLevel":1}]`. `objectId` ties it to the hierarchy level; `field` is the field on the selected record; `question` is the question Name that receives it. A Task Template's Form is the SurveyVersion Id, not the Survey Id, so every new version needs the Task Templates repointed.
8. **Inserting a Job Template through the API creates its queue** (same second) and makes the queue the owner. The API does not add the public group to the queue; that is a separate `GroupMember` insert on the queue, and it must be a separate transaction from the Job Template insert or Salesforce throws a mixed DML error. `TasksNumber` is a formula and not writeable.
9. **Assignment chain:** Job Template, its Queue, Public Group as a member of the Queue, users as members of the Group. Adding a collector is adding them to the group. The mobile-user admin page displays group names from a text field, and it has shown a membership that was never written; the truth is the `GroupMember` table, so always verify by query.
10. **Record assignment does not share.** Assigning records to a mobile user writes `SObjectUserAssociation` only. Account is Private for external users, so a community collector saw no schools until a criteria-based Account sharing rule (ShippingCountry equals Zambia, to the collector public group, read only) was deployed. A sharing rule on Account must carry `accountSettings` with case, contact and opportunity access levels and sit among `sharingCriteriaRules` before any `sharingOwnerRules`.
11. **Collector login route.** Internal users fight Salesforce MFA and passkey enrolment (WebAuthn cannot complete inside an emulator's WebView; users must not have WebAuthn methods if they log in from an emulator). The working route is a community user: profile TaroWorks Customer Community Plus User, Customer Community Plus licence, under the TaroWorks partner account, member of the collector public group. Three things make any login work: the TaroWorks Mobile User permission set, a package licence, and membership of a group that sits in a Job's queue.
12. **The mapping runs as the submitting user.** Records are created by the mobile user, so a permission set granting create and edit on the target object, its fields and its record types is load-bearing. Record types created by deployment are invisible until `recordTypeVisibilities` is granted on the collector permission set; without it the insert fails with `INVALID_CROSS_REFERENCE_KEY`.
13. **What a submission produces**, from our first end-to-end test: Submission `SA-000001` with 38 Answer rows, Status Uploaded, start and end timestamps, MD5; four target records (one per repeat instance across two repeats), each stamped with the collector from `SurveyorApiField`, the Submission Id from `SubmissionApiField`, and whatever the org's own flows add. Answers for repeat questions carry Instance 1, 2, and so on, and a Parent Answer for the repeat container.
14. **Photos.** Compatible target field types are Text and URL. The mapped value is a link to the image stored as a File on the Submission; a viewer without access to the package objects gets a permission page. We link the same File a second time to the created record (ContentDocumentLink, visibility AllUsers) by flow so anyone who can see the record can open the photo. A display formula `IF(ISBLANK(url), "", IMAGE(url, "photo", 150, 200))` renders it on the layout.
15. **Dynamic Operations (JavaScript on the phone).** DynamicOperationType Validation with a script that reads `tw.section.question.value` and `throw`s to fail; Calculation to compute a value. A Validation only runs on required questions with an answer. ResponseValidation is a separate, earlier regular-expression check (for example `^([01][0-9]|2[0-3]):[0-5][0-9]$` for a time typed as text). DoBefore and DoAfter run scripts before and after a question.
16. **Question rendering.** Sections are pages; SamePage keeps a question on the previous question's page; Hidden hides a question (used with calculations, and `RunHiddenDynamicOperations` on the Survey controls whether hidden operations run). Static content is a note. `end_of_survey` ends the form early. Hints render as collector-facing help text under the caption.
17. **Repeats.** A repeat question owns child questions. RepeatCondition fixed with RepeatTimes, or previews_answer with RepeatSourceValue (a numeric question that sets the count), or undetermined (collector adds instances up to MaxInstance). IsRepeatInTable renders instances as a grid. A group in a source form that mixes once-only questions with a repeat must be split into a section for the once-only questions and a repeat for the rest, otherwise once-only questions are asked once per instance.
18. **Deleting a draft form** must delete, in order: question mappings, object relationship mappings, survey mappings, skip conditions, options, child questions, then parent questions, then versions, then the survey. There is no cascade.
19. **Versions on the phone.** The app downloads published versions; a Task Template pointing at a superseded version keeps serving that version until repointed.
20. **Task types.** A Task Template can be a form, a data view (show a record's fields to the collector) or a list view (show related records), so a Job can be "visit the school, review its details, then fill three forms".
21. **Error log** rows carry only type, code, message, object and user; the raw failed XML is not kept in Salesforce.
22. **Package limits we ran into:** none on question count (our largest form is 144 questions in 13 sections and 1 repeat); the Salesforce limit that bit was the 500 custom fields per object on the target.

---

## Part B. The reference implementation, which the acceptance tests use

Splash is the first customer and its implementation is the reference case. It is one customer's schema, not part of the product; what matters is the set of capabilities it relies on, because every one of them is exercised by the acceptance tests in C10.

- One custom object holds every instrument's records, with a record type per instrument (student survey, teacher interview, infrastructure observation, handwashing observation, and three routine-monitoring types). A record is one instrument at one school on one visit, or one repeat instance of it (one student, one observed child). The tool must set the record type per mapping as a constant; the customer's own flows may add further stamps.
- Every record carries a lookup to the school (the Job target), a stage, a visit date, an occurrence number (the nth visit of that instrument at that school in that stage), the collector, the source platform, and the submission Id as an external Id. The tool supplies the target lookup, the collector stamp, the submission stamp and the occurrence number; the customer maps the rest from questions.
- Photo questions map to URL fields and the customer renders them with a display formula. Time-of-day questions are typed as text with a regular expression and converted by a customer flow. Composite scores are the customer's formula fields fed by a nightly flow over the visit's child records. None of this is the tool's concern beyond delivering the mapped values and the linked files.
- Forms were generated from CommCare Form Summaries by script and loaded through the API, so the tool's APIs must allow a form, its mappings and its job to be created and published entirely by script.
- History was loaded from CommCare's Form API by upsert on an external Id, with occurrence numbers computed in the file. The tool's own occurrence numbering must respect values already present on records loaded that way.
- The customer's MLE lead signs forms off from a printed question-by-question view, which is why the print view in C5 exists.

---

## Part C. The tool you will build

### C1. Mission and non-negotiables

Build the tool Splash owns: forms designed in Salesforce, run offline on Android through the ODK XForms standard, work assigned as Jobs and Tasks tied to Salesforce records, submissions mapped into any object with parent and child records, photos attached to the records they belong to. It must do everything in Part A that Splash uses, support everything in Part B unchanged, and fix the defects in C3.

1. Forms are authored in Salesforce in a Lightning builder and stored as Salesforce records. No external server holds the source of truth.
2. Every published form compiles to a valid ODK XForm that stock ODK Collect renders unchanged, and to an XLSForm for humans. Validate with ODK Validate (JavaRosa) at publish.
3. Offline first: download tasks and forms, work for a week without signal, sync when possible, lose nothing if the phone dies mid-sync.
3a. No Salesforce licence per collector. The tool connects to each org as one integration user through a connected app; collectors and online respondents authenticate to the tool or use a shared link. A customer with five free Salesforce Integration User licences pays nothing more to add a hundred collectors.
3b. The same published form runs online in a browser (Enketo) from a shareable link, with optional single-use links per Task and optional anonymous access, and submits through the same endpoint and the same mapping as the phone.
4. Jobs and Tasks: template, fan-out to one Task per target record, assignment to a group, per-collector visibility, prefill from the target, Task closure on submission, task types form, record view and list view.
5. Mapping: main record, repeat children with parent lookups, reference lookups by Id or by a matching field or by external Id, record type per mapping, picklist matching, multi-select joins, constants, collector and submission stamps.
6. Media as Salesforce Files linked to the mapped record, and to the submission, visible to anyone who can see the record.
7. Idempotent on the ODK instance Id; a retried sync never duplicates.
8. Everything the UI does, the APIs do: forms, mappings, jobs and publishing are scriptable and deployable between sandbox and production, including publish.
9. Packaged as an unlocked package plus a multi-tenant service (hosted by us or by the customer) plus the mobile app; sandbox and production are separate tenants, independently connectable.
10. No collector or respondent data leaves the customer's Salesforce org and the customer's own service. No third-party analytics. No vendor library catalogue.

### C2. Architecture

**Salesforce package (Apex, LWC, custom objects).** The form, mapping, job, collector and submission models; the builder; the XForm compiler (Apex, or the service if Apex is a poor fit, with the compiled XForm and XLSForm stored as Files on the version); the ingestion and mapping engine (Apex, bulk-safe for 200 submissions per call, running under the org's transaction model as the integration user); Apex REST endpoints for the service; permission sets Admin, Supervisor and Integration; a Collector record per collector that is not a Salesforce user. Collectors are people the customer names in the tool; the only Salesforce user involved is the integration user, which holds the Integration permission set and a Salesforce Integration User licence (five are free per org).

**Service (multi-tenant, stateless, containerised; customer-hosted or hosted by us).** One service can serve many Salesforce orgs; a tenant is one org, connected once by an administrator through the connected app's OAuth flow, with the refresh token or JWT certificate stored encrypted per tenant. Implements the OpenRosa API (`/formList`, `/forms/{id}`, media manifest and media, `/submission`, HEAD for submission negotiation) so stock ODK Collect works with the collector's tool credential over HTTPS. Hosts Enketo for online forms: a published form gets a shareable link, a Task can get a single-use link, and a form can allow anonymous submissions when the administrator says so. Serves a per-collector form list built from the collector's open Tasks, with the assigned targets delivered as itemsets or entity lists that the service builds by reading the targets as the integration user and filtering per collector, so no Salesforce sharing is involved. Stores raw XML and media durably before calling Salesforce, acknowledges the phone or browser only after Salesforce commits, retries with backoff, dead-letters into a Salesforce-visible queue, and batches calls so the org's daily API limit is the only throttle and is reported on the tenant's dashboard. Reference deployment on Azure (Container Apps plus a managed Postgres and blob storage) with Docker Compose for local development.

**Mobile.** Phase 1: stock ODK Collect configured by QR code to the service, with Jobs expressed as one Collect form per Job and Task template and the targets as an itemset filtered to the collector's group; choosing the target in the first question prefills the rest. Phase 2: a Kotlin Android app on the ODK JavaRosa engine with a real Task list, task status, prefilled read-only questions, sync status per task, device registration and app version gating, designed from the start so the sync API does not change.

**Web.** Enketo, served by the service, for online forms. Same XForm, same submission endpoint, same mapping. A browser respondent with a link is the online equivalent of a collector with a phone; when a Task link is used the submission closes that Task.

**What this changes versus TaroWorks, stated so nobody rediscovers it:** records are created by the integration user, so the collector is stamped into a field on every mapped record (and on the Submission) rather than appearing as CreatedBy, automatically from the Collector who submitted, with no question on the form needed (a customer may still add a collector-name question if they prefer, and both work); per-collector visibility is the service's job, enforced from the Task and assignment model; the org's API limits are shared with every other integration in the org, so the service must batch and must show its consumption; and the customer must read the indirect-access terms of its Salesforce agreement, which is standard for connector products and is noted in the administrator guide.

### C3. Defects and frictions in TaroWorks that the tool must design out

1. Photos attached only to the submission: link to the mapped record at ingestion.
2. Assignment through Queues and Public Groups with mixed DML: own assignment objects, no setup DML in data transactions.
3. Group membership displayed from a text field that can disagree with the database: every screen reads records.
4. A writeable-looking field that the API rejects (`TasksNumber`): everything the UI writes, the API writes, with the same validation.
5. Record types invisible until permission grants: publish checks that the integration user can see every mapped object, field and record type and names the missing ones.
6. Once-only questions inside a group that also repeats get asked per instance: groups may contain once-only questions and a repeat, and the compiler places them correctly.
7. Picklist mismatches and semicolons into single-selects: option-to-picklist matching at publish with warnings, never a multi-select join into a single-select.
8. Per-visit sequence numbers wrong under bulk: the ingestion engine computes an occurrence number per target, form and stage in submission-date order, correct under bulk and on backfill.
9. Prefill as undocumented JSON: a Prefill child object (question, source field or literal or collector attribute).
10. Publishing a new version silently orphans Task Templates pointing at the old version: a Task Template points at the Form, resolves to the current published version, and open Tasks carry forward by default or block publish, the administrator chooses.
11. No cascade delete for drafts and no protection for published forms: cascade delete for drafts, hard block for published forms with submissions.
12. No export or import of a form: XLSForm and JSON bundle, lossless round trip.
13. Error log without the payload: every failed submission keeps its raw XML, the stage it failed at and the DML error, with one-click retry after the fix.
14. No single view of question to field: the builder shows field, type compatibility and picklist match status per question, and a print view for reviewers.
15. Reference by matching Name: support matching by Id, by any unique field, and by external Id, and warn at publish when the matching field is not unique in the org.
16. Publishing only through the UI: publish is an Apex service callable from the CLI and from CI.
17. Record assignment without sharing, and sharing rules per country to make targets visible: the service reads targets as the integration user and serves each collector only the targets of their own Tasks, so no Salesforce sharing is ever needed for collection.
18. Collector login fights MFA in emulators and every collector needs a Salesforce licence: the collector credential is the tool's own, scoped to the mobile and web APIs, with device binding optional and no WebAuthn, and no Salesforce user behind it.
19. Hints shown as collector help text: keep Hint for collectors and add a separate Notes field for authors that never reaches the phone.
20. Mapping cannot write a fixed value: constants per mapping, including record type.

### C4. Salesforce data model

Objects with the fields that matter; add system fields as needed. API names without prefix.

- `Form`: Name, Status (Draft, Published, Retired), Description, Folder, Default_Target_Object, Current_Version, Language, Country, Allow_Ad_Hoc_Submissions, GPS_Capture (none, start, end, both), Close_Message.
- `Form_Version`: Form, Version_Number, Status (Draft, Published, Superseded), XForm (File), XLSForm (File), Compiled_At, Compile_Warnings, Published_By, Published_At, Change_Log.
- `Question`: Form_Version, Parent (self, for sections and repeats), Order, Name (XForm node name, unique in the version), Label, Hint, Author_Notes, Type (section, repeat, note, text, text_long, integer, decimal, select_one, select_multiple, date, time, datetime, geopoint, geotrace, geoshape, photo, signature, audio, video, file, barcode, calculate, reference, end), Required, Read_Only, Hidden, Same_Page, Default_Value, Calculation (XPath), Constraint (XPath), Constraint_Message, Regex, Regex_Example, Minimum, Maximum, Relevant (XPath, generated from skip rules or hand-written), Appearance, Choice_List, Repeat_Mode (fixed, from_answer, open), Repeat_Count, Repeat_Source_Question, Repeat_Max, Repeat_As_Table, Cascade_Level, Require_Live_Photo, Media_Max_Seconds, Prefill_Source (for reference questions), Validation_Script (phase 2 JavaScript; every rule must also be an XPath constraint or the builder warns), Previous_Version_Question.
- `Choice_List` and `Choice`: reusable lists; Choice has Value, Label, Order, Filter_Value (for cascading selects), Score. A select question may own inline choices as a list belonging to the question.
- `Skip_Rule`: Question (shown or hidden), Source_Question, Operator (answered, is, is_not, less_than, greater_than, in_range, contains), Value, Value_To, Join (all, any), Action (show, hide). Compiled into `relevant`.
- `Mapping`: Form_Version, Target_Object, Record_Type, Kind (main, repeat, reference), Repeat_Question, Parent_Mapping, Parent_Lookup_Field, Matching_Field (for reference), Upsert_External_Id_Field, Collector_Field, Submission_Field, Order.
- `Field_Mapping`: Mapping, Question, Target_Field, Transform (none, picklist_match, multi_select_join, lookup_by_external_id, date_only, boolean_yes_no, number, text_truncate, geopoint_lat, geopoint_lng, geopoint_accuracy, file_url), Constant_Value, Match_Status (ok, warning, error), Match_Detail.
- `Job_Template`: Name, Status (Draft, Published, Closed), Description, Instructions, Folder, Target_Object, Target_Filter (SOQL WHERE fragment or list view Id), Drill_Down (child object `Drill_Down_Level`: Level, Object, Label, List_Fields, Detail_Fields, Filter, Parent_Lookup), Assignment_Group, Task_Expiry_Days, Submissions_Per_Task (one, many), Share_Targets_With_Group.
- `Task_Template`: Job_Template, Order, Type (form, record_view, list_view), Form, Object, List_View, Instructions.
- `Prefill`: Task_Template, Question_Name, Source (target_field, literal, collector_field, parent_level_field), Source_Value, Read_Only_On_Phone.
- `Assignment_Group` and `Assignment_Group_Member` (Collector). No Queues, no Public Groups.
- `Job`: Job_Template, Name, Status (Draft, Open, Paused, Closed), Opened_At, Closed_At, Target_Count, Task_Count, Completed_Count.
- `Task`: Job, Task_Template, Target_Record_Id, typed lookups for Account and Contact at least, Status (Open, Downloaded, Started, Submitted, Closed, Expired), Assigned_Group, Claimed_By (Collector), Form_Version, Prefill_JSON (materialised), Submission, Occurrence_Number, Started_At, Ended_At, Start_Location, End_Location, Channel (phone, web).
- `Collector`: Name, Email, Phone, Username (unique per tenant), Status (Active, Inactive, Blocked), Language, Country, Last_Sync_At, Last_Login_At, App_Version, Device, Credential_Set_At, Salesforce_User (optional lookup for staff who also have a licence, for reporting only), Contact (optional). The credential itself lives hashed in the service, never in Salesforce.
- `Form_Link`: Form_Version or Task, Token, Mode (open, single_use, anonymous), Expires_At, Uses, Created_By. Backs the online form links.
- `Tenant_Connection` (service side, not Salesforce): org Id, instance URL, encrypted refresh token or JWT certificate, API usage counters.
- `Device`: Device_Id, Model, OS, App_Version, Last_Seen_At, Last_Seen_By.
- `App_Version`: Version, Minimum_Supported, Download_URL, Active, Released_At.
- `Submission`: Form_Version, Task, Collector (null for anonymous web submissions), Channel (phone, web), Form_Link, Instance_Id (external Id, unique), Submitted_At, Received_At, Started_At, Ended_At, Device, Latitude, Longitude, Accuracy, Raw_XML (File), XML_Hash, Status (Received, Mapped, Failed, Reprocessed), Mapped_Record_Id, Error, Failed_Stage, Attempts.
- `Answer`: Submission, Question, Repeat_Path, Repeat_Index, Parent_Answer, Value, Numeric_Value, Date_Value, Datetime_Value, Choice, File (ContentDocument Id).
- `Scoring_Group`, `Score_Value`, `Submission_Score`: keep the scoring feature, because the MLE team uses composite scores.
- `Performance_Target` and `Assigned_Target`: keep, simplified: a target per collector per period on a tracked object and field, with progress shown on the phone in phase 2.
- `Sync_Log`: one row per sync call with counts and duration; `Error_Log` rows link to the Submission.
- `Folder`: for forms and job templates.

Not carried over: PPI, mobile money, survey library, contact groups and client assignation, interviewee on submission (Splash does not interview identified individuals; student records carry no identifying data, enforced by not creating the fields).

Sharing and permissions: collectors have no Salesforce access at all. The integration user holds the Integration permission set, which grants the package objects plus whatever target objects, fields and record types the administrator maps; publish checks those grants and names anything missing. Administrators and supervisors are ordinary Salesforce users with the Admin and Supervisor permission sets. What a collector may see and do is decided by the tool from the Collector, Assignment Group, Job and Task records, and enforced by the service.

### C5. Form builder

A Lightning app page: a tree of sections, repeats and questions with drag to reorder and nest, keyboard accessible; a property panel per question with every field in C4, a live XPath validator, and a test-on-phone button that puts a draft on the service and shows a QR code; a skip-logic editor that writes Skip Rules and shows the compiled `relevant`; a mapping panel to choose target object, record type and kind for the main record and each repeat and reference, map questions to fields with type-aware pickers, and show every warning in place; choice list management with cascading selects fed from static choices or from a Salesforce query refreshed at Job open (for example the schools in a country); publish (compile, ODK Validate, permission and picklist and uniqueness checks, snapshot, carry forward open Tasks per C3 item 10); import and export as XLSForm and JSON bundle, accepting the forms in `seed/xlsform/` without hand edits; a read-only print view with question names, labels, types, choices, relevance, constraints and the mapped field of each question, which is what the MLE lead signs off from; version compare between two versions; clone a form; move a form between folders.

### C6. Jobs and Tasks

Creating a Job from a template runs the target filter, creates one Task per target per Task Template, materialises prefill, and makes the Job visible to its assignment group through the service; 400 schools by 4 forms is 1,600 Tasks in one run (queueable or batch). Collectors see Tasks by Job, target and form. Phase 1 expresses this to Collect as one form per Job and Task Template with the targets as an itemset filtered to the collector's group; the service resolves the Task from Job, form and target on submission and closes it. Phase 2 shows a real Task list with record views and list views. A Task can be claimed so two collectors do not visit the same school. One submission closes the Task by default; a template can allow many (routine monitoring). Expired Tasks leave the phone on next sync. Supervisors get a Job dashboard: targets, tasks by status, submissions per day and per collector, a map when targets carry geolocation. Prefilled reference questions are compiled read-only and the engine writes the Task's target Id into the mapped lookup regardless of what the phone sends.

### C7. Ingestion and mapping engine

Apex, invoked by the service with a batch of submissions (raw XML plus media manifest). Steps, each logged with its stage name:
1. Parse the XML against the version's question tree; unknown nodes become Answers with a warning, never dropped.
2. Upsert Submission on Instance_Id; if it exists and is Mapped, return success without touching records.
3. Write Answers with repeat paths and parent answers.
4. Resolve the Task (from the task Id the phone sent, the Form Link token the browser used, else Job, form and target) and the Collector; compute Occurrence_Number.
5. Build the main record from the main Mapping (record type, constants, transforms, target lookup from the Task, collector name or Collector Id and submission Id stamped into the fields the mapping names, since CreatedBy will be the integration user), resolve reference mappings (by Id, matching field or external Id; fail clearly when zero or many match), build child records per repeat Mapping with the parent lookup; insert in one transaction, parent first, children next; roll back all on any failure and mark the Submission Failed with the DML message and the record index.
6. Media: ContentVersion per file, ContentDocumentLink to the mapped record (main or child by where the question sits) and to the Submission, set the mapped URL or text field.
7. Close the Task, stamp Submission Mapped, return per-submission results.
8. Re-map from stored Answers for Failed or Mapped submissions after a mapping fix (the latter deletes and recreates, with confirmation).

Transforms: picklist label to API value, case-insensitive, from a match table built at publish; multi-select semicolon join with deduplication; ODK date and datetime into the org time zone; geopoint into latitude, longitude and accuracy; locale-safe numbers; yes and no into checkboxes; text truncated to field length with a warning; file into URL. Governor limits: 200 submissions with 30 children each must succeed in one call; chunk inside Apex and report partial progress so the service retries only what failed.

### C8. Security and operations

TLS everywhere; collector credentials hashed with a modern KDF and never stored in Salesforce; per-tenant Salesforce tokens encrypted at rest with a key the tenant can rotate; strict tenant isolation in every query and every storage path, tested; the integration user carries only the Integration permission set; field-level security checked at publish, not discovered at ingestion; the service purges acknowledged payloads after a configurable retention (default 7 days); audit of who published, who opened which Job, who re-mapped which submission, who created which form link; anonymous links rate-limited and expirable; app version gating with a minimum supported version; device registration; API-limit consumption per tenant shown and alerted; a health endpoint and metrics for the service; backups of the service database documented.

### C9. Migration

Provide: a converter from TaroWorks definitions (`Survey`, `SurveyVersion`, `Question`, `Option`, `SkipCondition`, `SurveyMapping`, `QuestionMapping`, `ObjectRelationshipMapping`, `JobTemplate` with its Hierarchy JSON, `TaskTemplate` with its Mapping JSON; schema in `seed/`) into the new model, so our seven forms and seven Job Templates convert without hand edits and compile to valid XForms; an XLSForm importer that takes CommCare exports converted to XLSForm; a submission importer that takes TaroWorks `Submission` and `Answer` rows into the new Submission and Answer objects so history survives the package uninstall; and a documented cut-over: freeze TaroWorks publishing, convert, parallel run one round, switch collectors, uninstall.

### C10. Acceptance tests, from our real forms

Automate end to end against a scratch org and a local service, with ODK Collect in an emulator or a scripted OpenRosa client:
1. The 144-question infrastructure observation (13 sections, one repeat of up to 5 water tanks) creates one observation and n tank children with four photos linked to the observation.
2. The HWWS observation with station questions asked once, up to 40 students in a repeat, then three closing questions, creates one observation and n student children; the count matches the collector's stated count.
3. The head teacher interview with a repeat of exactly 5 sampled students creates one interview and 5 students; the school lookup comes from the Task target even if the phone sent a different value.
4. A Job across 302 schools with two forms creates 604 Tasks; a collector in the group downloads only those; a collector outside downloads none; no Salesforce user or sharing rule was created for either collector.
5. The same submission delivered twice creates records once.
6. A submission with an unknown picklist value fails cleanly, shows in the error view with its XML, and succeeds on retry after the value is added and the submission re-mapped.
7. Publishing version 2 while 40 Tasks are open carries them to version 2 and Collect downloads the new form on next sync.
8. Twelve tasks completed offline over three days sync over a connection that drops twice; all twelve arrive once.
9. Removing write access to one mapped field from the integration user makes publish fail naming the field.
10. Export as XLSForm, import into a fresh org, compare compiled XForms byte for byte after normalising Ids.
11. Convert the seven TaroWorks forms from `seed/` and publish all seven from the CLI without opening the UI.
12. A form with a time typed as text, a regular expression, and a JavaScript validation compiles to an XForm whose constraint enforces the same rule in stock Collect.
13. The same published teacher interview is completed once on the phone offline and once in a browser from a Task link; both produce identical records apart from the channel, the browser one closes its Task, and a second use of the single-use link is refused.
14. Two tenants connected to two scratch orgs: a form, a job and a submission in one are invisible to the other through every endpoint, and a submission for tenant A never reaches org B, even with a forged tenant header.
15. The service's API calls for a 200-submission sync stay under a stated budget (decide the number, then hold it), and the tenant dashboard shows the consumption.

### C11. Delivery plan

Phases; do not start one until the previous passes its tests.
- Phase 0: repository, scratch org definition, CI (Salesforce CLI, Apex tests at 85 percent or better, service tests, lint), ADR folder, this brief committed as `docs/brief.md`.
- Phase 1: data model, XForm compiler, XLSForm import and export, print view, CLI publish. Tests 10, 12.
- Phase 2: multi-tenant service with tenant connection, OpenRosa, ingestion and mapping engine, media linking, idempotency, error view and re-map. Tests 1, 2, 3, 5, 6, 8, 14, 15.
- Phase 3: Jobs, Tasks, assignment groups, collectors and credentials, prefill, itemset delivery, Task closure, dashboards; Enketo online forms and form links. Tests 4, 7, 13.
- Phase 4: form builder UI, publish checks, security checks. Test 9.
- Phase 5: migration converters and cut-over runbook, run against `seed/`. Test 11.
- Phase 6: Android app on JavaRosa with Task list, record and list views, targets, version gating (design during phases 1 to 5, build after).
- Phase 7: packaging as a versioned unlocked package, Azure deployment guide, administrator guide, collector guide, MLE reviewer guide.

### C12. Working rules

Keep `docs/` current: architecture, data model, the service's OpenAPI contract, the OpenRosa endpoints implemented, the ADRs. Every object and field carries a description; every Apex class states its responsibility in a header. Store nothing about collectors or submissions outside the customer's org and service database. Ask before choosing between unlocked and managed packaging, or adding a paid dependency. Decide and record the service language and framework, the database, the ODK Collect and Enketo versions to target, the Salesforce OAuth flow for tenant connections, and the namespace prefix. Never introduce a design that requires a Salesforce licence per collector; if something seems to need one, stop and ask. Where this brief conflicts with the ODK XForms specification, the specification wins and an ADR notes it. Do not build PPI, mobile money, the survey library or contact groups; note in an ADR that they were excluded on purpose.

### C13. Distribution: open source first, AppExchange later if ever

The product is built in the open from the first commit, in the manner of community Salesforce projects such as SalesforceDocGen (Apache-2.0, SFDX source, CONTRIBUTING and a code of conduct, issues, pull requests and discussions on GitHub).

- One public GitHub organisation with three repositories, or one monorepo with three top-level folders: the Salesforce package (SFDX source), the service, and the mobile app. Decide and record.
- Licence: Apache-2.0 for the Salesforce package and the mobile app. For the service, decide between Apache-2.0 and AGPL-3.0 and record the reasoning; the service is where a hosted offering could be charged for, and the licence choice should not block a customer from self-hosting.
- Installation for a Salesforce administrator must be two routes, both documented on the README: a versioned unlocked package installable by package Id link into any org, and a source deploy with the Salesforce CLI for people who want to read the code first. Releases are tagged, with release notes, and the package version is published on every release by CI.
- The service ships as a container image on every release, with a one-command local run and the Azure deployment guide. The mobile app ships as a signed APK on every release, and to Google Play once phase 6 is stable.
- Contribution: CONTRIBUTING.md (how to set up a scratch org and the local service, how to run the acceptance tests, coding standards), a code of conduct, issue templates for bugs and feature requests, a pull request template that requires tests, and Discussions enabled. Maintainers review; the acceptance suite in C10 runs on every pull request.
- Trademark and naming: the product name is ours; forks must rename. Note this in the README.
- AppExchange is a later, optional path: it requires a managed package, the Salesforce partner programme and a security review, and it does not fit an unlocked open-source package as is. Design so that a managed-package build of the same source is possible (no hard-coded org Ids, no reliance on unpackaged metadata), but do not do the managed build until asked.
- Third-party components and their licences must be compatible with the above: ODK Collect and JavaRosa (Apache-2.0), Enketo (Apache-2.0), ODK Validate (Apache-2.0). Record every dependency and its licence in `docs/licences.md`.

---

## Part D. Seed material in `seed/`

- `gfsurveys__*.json`, 44 files: every TaroWorks object as installed, with fields, types, lengths, references, active picklist values, required, createable, updateable and formula flags.
- `_worked_example_HWWS_form_job_submission.json`: the real HWWS form version (`a2hPQ000001B4e1YAC`) with its 44 questions, 109 options, 13 skip conditions, 3 survey mappings (Account reference with MatchingField Name, and two Site Survey repeat mappings with `SurveyorApiField` Collector__c and `SubmissionApiField` TaroWorks_Submission_Id__c), 49 question mappings and 2 object relationship mappings on `Site__c`; the Job Template and its Task Template with the prefill JSON; the three latest Jobs and Tasks; the two latest Submissions and the 35 answers of the latest; three mobile user rows; one error log row.
- `xlsform/`: XLSForm exports of our forms, when supplied.
- To be added on request: the generator script and one CommCare Form Summary, and the field list of `Site_Survey__c`.
