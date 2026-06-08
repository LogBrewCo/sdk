# LogBrew C SDK

Public C99 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK is dependency-free and ships as source plus header. Add `include/logbrew.h` and the files under `src/` to your application build:

```bash
cc -std=c99 -Wall -Wextra -Wpedantic -Iinclude src/logbrew.c src/logbrew_recording_transport.c src/logbrew_timeline.c your_app.c -o your_app
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

## Product Timelines

Use product timeline helpers when your native app owns meaningful user-flow steps or API milestones that should line up with logs, errors, spans, and traces. They enqueue normal LogBrew `action` events with primitive metadata so LogBrew and AI agents can analyze many sessions without visual replay:

```c
LogBrewMetadataEntry metadata[] = {
  LOGBREW_METADATA_NUMBER_VALUE("cartValue", 42.5),
  LOGBREW_METADATA_BOOL_VALUE("retry", false)
};
LogBrewProductTimelineContext context = {
  "session_123",
  "trace_001",
  "/checkout",
  "Checkout",
  "checkout",
  "submit"
};

logbrew_client_product_action(
    client,
    "evt_action_checkout_submit",
    "2026-06-02T10:00:06Z",
    (LogBrewProductActionAttributes){
      "checkout.submit",
      "success",
      context,
      {metadata, sizeof(metadata) / sizeof(metadata[0])}
    },
    &error);

logbrew_client_network_milestone(
    client,
    "evt_network_checkout_api",
    "2026-06-02T10:00:07Z",
    (LogBrewNetworkMilestoneAttributes){
      "post",
      "https://api.example.com/api/checkout?sku=123#pay",
      503,
      true,
      184.5,
      true,
      context,
      {metadata, sizeof(metadata) / sizeof(metadata[0])}
    },
    &error);
```

Network helpers normalize the method, strip query strings and fragments from route templates, reduce HTTP(S) URLs to paths, default HTTP `4xx` and `5xx` milestones to `failure`, and keep metadata primitive. They do not patch HTTP clients, record visual replay, collect headers, or capture request or response bodies. Keep user-entered text, raw URLs, query strings, headers, and payloads out of timeline metadata.

## Example Source

The `examples/readme_example.c` source shows a complete six-event payload and recording transport setup that you can copy into your own native application.
