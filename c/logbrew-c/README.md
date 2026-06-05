# LogBrew C SDK

Public C99 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK is dependency-free and ships as source plus header:

```bash
cc -std=c99 -Wall -Wextra -Wpedantic -Werror -Iinclude src/logbrew.c examples/readme_example.c -o readme_example
./readme_example
```

From this repository:

```bash
make -C c/logbrew-c
make -C c/logbrew-c/examples
make -C c/logbrew-c/examples run-readme-example
make -C c/logbrew-c/examples run
make -C c/logbrew-c/examples run-real-user-smoke
```

## Minimal Usage

```c
#include "logbrew.h"

LogBrewClient *client = NULL;
LogBrewError error;
LogBrewConfig config = {
  "LOGBREW_API_KEY",
  "logbrew-c",
  LOGBREW_C_VERSION,
  2U
};

logbrew_error_clear(&error);
if (logbrew_client_new(config, &client, &error) != LOGBREW_OK) {
  /* error.code and error.message are stable public fields */
}

logbrew_client_release(
    client,
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    (LogBrewReleaseAttributes){"1.2.3", "abc123def456", "Public release marker"},
    &error);

LogBrewRecordingTransport transport;
LogBrewTransportResponse response;
logbrew_recording_transport_init(&transport, NULL, 0U);
logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
logbrew_recording_transport_free(&transport);

logbrew_client_free(client);
```

## Examples

The package ships two examples:

- `examples/readme_example.c` builds the canonical six-event payload and flushes it through a recording transport.
- `examples/real_user_smoke.c` exercises success, empty flush, validation failure, unauthenticated response, retry recovery, retry-budget exhaustion, non-retryable transport status, shutdown, and post-shutdown rejection.

The helper Makefile is intentionally small and discoverable:

```bash
make -C examples
make -C examples run-readme-example
make -C examples run
make -C examples run-real-user-smoke
```
