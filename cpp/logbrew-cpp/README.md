# LogBrew C++ SDK

Public C++17 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK is dependency-free and ships as source plus header. Add `include/logbrew.hpp` and `src/logbrew.cpp` to your application build:

```bash
c++ -std=c++17 -Wall -Wextra -Wpedantic -Iinclude src/logbrew.cpp your_app.cpp -o your_app
```

## Minimal Usage

```cpp
#include "logbrew.hpp"

logbrew::LogBrewClient client(
    logbrew::Config{"LOGBREW_API_KEY", "logbrew-cpp", logbrew::version, 2});

client.release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    logbrew::ReleaseAttributes{"1.2.3", "abc123def456", "Public release marker"});

logbrew::RecordingTransport transport;
logbrew::TransportResponse response = client.flush(transport);
```

`logbrew::SdkException` exposes a stable `code()` plus the exception message. `logbrew::Transport` is an abstract callback surface for real HTTP transports, while `logbrew::RecordingTransport` lets your app inspect queued JSON before network delivery.

## Example Source

The `examples/readme_example.cpp` source shows a complete six-event payload and recording transport setup that you can copy into your own native application.
