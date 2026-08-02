# Product Analytics Capture Contract

LogBrew uses existing action and page-view telemetry for product analytics. SDK helpers add a small reserved metadata vocabulary so the backend can distinguish product usage from technical actions without collecting a visual replay.

## Version 1

Classified events carry these primitive metadata fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `analyticsSchemaVersion` | integer | Exact contract version. Version 1 is the only current value. |
| `analyticsKind` | string | `page_view`, `screen_view`, or `interaction`. |
| `analyticsSurface` | string | Optional stable page route template or app screen name. |

`analyticsSurface` is trimmed, limited to 256 Unicode characters, and omitted when it is empty, too long, or contains control characters. Browser route surfaces exclude query strings and hash fragments. Prefer route templates such as `/orders/:id` instead of concrete paths such as `/orders/8472`.

The three fields are reserved. SDK helpers write them after app metadata, so app metadata cannot change the schema version or reclassify an event.

## Signal Mapping

- Browser page-view spans use `page_view` and a path-only surface.
- Mobile screen-view actions use `screen_view` and the app-owned screen name.
- Explicit product actions use `interaction`. A sanitized route template or screen name can become the surface when the helper has one.
- Network milestones, app lifecycle events, logs, issues, and ordinary performance spans are not product interactions and do not receive these annotations.

Existing unannotated events remain valid. Consumers must report classified and unclassified coverage separately instead of assuming that every action is a click or product event.

## Identity And Privacy

The analytics vocabulary does not discover or generate identity. Where supported, use the shared telemetry context with an explicit opaque `subject.id` and `session.id` when user- or session-level analysis is required. Do not use email addresses, names, phone numbers, raw IP addresses, authorization values, cookies, user-entered text, DOM selectors, full URLs, query strings, screenshots, or replay payloads as identifiers, surfaces, action names, or metadata.

Existing capture options stay unchanged. These annotations classify telemetry that the application already sends; they do not install click listeners, inspect form values, or add new automatic events.

## Compatibility

Readers must ignore unknown future `analyticsKind` values and unsupported schema versions. Writers must not emit a new kind or change field meaning without a new documented schema version. The JavaScript constants `PRODUCT_ANALYTICS_SCHEMA_VERSION` and `PRODUCT_ANALYTICS_KINDS` expose the values supported by the installed core package.
