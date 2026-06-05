# LogBrew C++ SDK

Public C++17 SDK for building, validating, previewing, and flushing LogBrew event batches from native applications.

The SDK is dependency-free and ships as source plus header:

```bash
c++ -std=c++17 -Wall -Wextra -Wpedantic -Werror -Iinclude src/logbrew.cpp examples/readme_example.cpp -o readme_example
./readme_example
```

From this repository:

```bash
make -C cpp/logbrew-cpp
make -C cpp/logbrew-cpp/examples
make -C cpp/logbrew-cpp/examples run-readme-example
make -C cpp/logbrew-cpp/examples run
make -C cpp/logbrew-cpp/examples run-real-user-smoke
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

`logbrew::SdkException` exposes a stable `code()` plus the exception message. `logbrew::Transport` is an abstract callback surface for real HTTP transports, while `logbrew::RecordingTransport` keeps examples and tests deterministic.

## Examples

The package ships two examples:

- `examples/readme_example.cpp` builds the canonical six-event payload and flushes it through a recording transport.
- `examples/real_user_smoke.cpp` exercises success, empty flush, validation failure, unauthenticated response, retry recovery, retry-budget exhaustion, non-retryable transport status, shutdown, and post-shutdown rejection.

The helper Makefile is intentionally small and discoverable:

```bash
make -C examples
make -C examples run-readme-example
make -C examples run
make -C examples run-real-user-smoke
```
