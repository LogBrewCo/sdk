# LogBrew C SDK

Public C99 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK is dependency-free and ships as source plus header. Add `include/logbrew.h` and `src/logbrew.c` to your application build:

```bash
cc -std=c99 -Wall -Wextra -Wpedantic -Iinclude src/logbrew.c your_app.c -o your_app
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

## Example Source

The `examples/readme_example.c` source shows a complete six-event payload and recording transport setup that you can copy into your own native application.
