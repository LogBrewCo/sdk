# Persistent drop counts

Clients that keep events across restarts also keep the drop counts that LogBrew
has not yet acknowledged. After a crash, restart, or reload, the next request
still carries the counts, and a report that was already sent keeps its
`report_id`, so LogBrew counts it once. In-memory clients are unchanged.

## Saved state

| Field | Meaning |
| --- | --- |
| `unreported` | `{reason: count}` for drops that no request has carried yet. |
| `pending` | `{report_id, dropped_events}` for counts frozen under one report ID until a 2xx acknowledges a request that carried them. |

Stores that already keep the request being sent or retried (Go, PHP) keep
`pending` inside that request and save only `unreported`. Other stores save
both.

## Rules

- **Validation on load.** Keep only reasons that match
  `^[a-z][a-z0-9_]{0,63}$` with an integer count from 1 to 1,000,000,000, and a
  `report_id` that matches `^[A-Za-z0-9_-]{16,64}$`. Keep at most 16 reasons.
  Drop anything else. Unreadable counts are ignored; they never block opening
  the store and never touch queued events.
- **When to save.** Save at once when a drop reason first appears, when counts
  freeze under a report ID, and when a 2xx clears them. During a drop burst,
  save at most once a second. Save again at shutdown.
- **Failed save.** Keep the counts in memory and never block capture.
- **Contents.** Reason codes, counts, and a random report ID only. Never event
  data.
- **Clear when empty.** With no counts left, remove the saved state so the
  store returns to its previous shape.

## Compatibility

A store gains the saved counts (and, in Java and Python, the gaps that crash
report eviction leaves) only while they are in use.

- A newer SDK reads stores written by older SDKs, and ignores optional state
  it does not know.
- An older SDK that finds newer state refuses to open the store with an
  integrity error. It leaves the files untouched and does not delete or
  overwrite queued events. Run the newer SDK until the queue drains and the
  saved state clears, and the older SDK opens it again.
- Neither direction loses queued events.
