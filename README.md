# Kusanya

Kusanya (Swahili: to gather) is an open-source field data collection platform for Salesforce. Administrators design forms inside Salesforce, collectors run them offline on Android through the ODK XForms standard or online in a browser, work is assigned as Jobs and Tasks tied to Salesforce records, and every submission is written back into Salesforce as records of any object, with photos attached to the records they belong to.

Two things set it apart from the products it replaces:

- **No Salesforce licence per collector.** Kusanya connects to each org once, as an integration user. Collectors log in to Kusanya, never to Salesforce.
- **One form, offline and online.** The same published form runs on a phone without signal and in a browser from a shared link, and both submit through the same mapping.

## Status

Pre-alpha. The build brief is in [docs/brief.md](docs/brief.md); the verification protocol every change is held to is in [docs/verification.md](docs/verification.md). Decisions are recorded in [docs/decisions](docs/decisions).

## Repository layout

| Folder | What it holds |
|---|---|
| `salesforce/` | The Salesforce package (SFDX source): objects, Apex, Lightning components, permission sets |
| `service/` | The multi-tenant service: OpenRosa endpoints, Enketo hosting, Salesforce connection, ingestion relay |
| `mobile/` | The Android app on the ODK JavaRosa engine (phase 6) |
| `seed/` | Reference material: the schema of the product being replaced and a worked example of a real form, job and submission |
| `docs/` | Brief, architecture, data model, API contracts, verification protocol, decisions |

## Built on

ODK XForms, ODK Collect, JavaRosa, Enketo and ODK Validate, all Apache-2.0. Kusanya is Apache-2.0 for the Salesforce package and the mobile app; the service licence is recorded in `docs/decisions`.

## Installing

Not yet. When the first release exists this section will carry two routes: a versioned unlocked package installable by link into any Salesforce org, and a source deploy with the Salesforce CLI.

## Contributing

See CONTRIBUTING.md once it lands. Until then, open an issue.

## Name and trademark

Kusanya is the name of this product and belongs to Cobitech Solutions. The code is free to use, modify and redistribute under its licence; forks that are distributed to others should use a different name.
