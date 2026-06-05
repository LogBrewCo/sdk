# LogBrew Unity SDK

Unity package for building, validating, previewing, and flushing LogBrew event batches from games and realtime apps.

The package is source-only, targets Unity `2021.3` or newer through UPM, and has no runtime package dependencies. The repository checks pack the Unity package, inspect the artifact, compile the runtime with nullable reference types, warnings as errors, and built-in .NET analyzers in `AnalysisMode=All`, run shipped samples, and exercise failure/lifecycle paths without requiring the Unity Editor.

## Install

Add the package through Unity Package Manager from a Git URL or a local package path:

```json
{
  "dependencies": {
    "co.logbrew.unity": "file:../Packages/co.logbrew.unity"
  }
}
```

Use the placeholder key in examples only:

```csharp
using LogBrew.Unity;

var client = LogBrewUnity.CreateClient(
    apiKey: "LOGBREW_API_KEY",
    gameName: "my-unity-game");

client.Release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456"));

LogBrewUnity.CaptureSceneLoaded(
    client,
    "evt_scene_loaded_001",
    "2026-06-02T10:00:06Z",
    "MainMenu",
    context: UnityContext.Create().WithPlatform("ios").WithSessionId("session_001"));

string preview = client.PreviewJson();
TransportResponse response = client.Flush(RecordingTransport.AlwaysAccept());
```

## HTTP Delivery

Use `HttpTransport` when the game or realtime app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors, proxies, and tests:

```csharp
var transport = new HttpTransport(
    new Uri("https://api.logbrew.com/v1/events"),
    new Dictionary<string, string> { ["x-logbrew-source"] = "unity-client" },
    TimeSpan.FromSeconds(10));

TransportResponse response = client.Flush(transport);
```

Keep personally sensitive values out of event messages and metadata before calling `Flush(transport)`. Use `RecordingTransport.AlwaysAccept()` in tests when you want deterministic local JSON without network delivery.

## Samples

From `unity/logbrew-unity`:

```bash
cd examples && make
cd examples && make run-readme-example
cd examples && make run
cd examples && make run-real-user-smoke
```

`make run` is the shorter alias for the stronger real-user smoke sample.

## Behavior

- `PreviewJson()` returns the queued batch as pretty JSON.
- `Flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `Shutdown(transport)` flushes queued events and rejects later writes.
- `HttpTransport` uses `HttpClient`, supports endpoint/header/timeout settings, and maps request failures to retryable `TransportException.Network(...)` failures.
- `LogBrewUnity.CaptureSceneLoaded()` records Unity scene transitions as action events.
- `LogBrewUnity.CaptureLogMessage()` maps Unity log types to LogBrew log levels.
- `LogBrewUnity.CaptureException()` records Unity exception details as issue events.
- `UnityContext` adds scene, object, platform, session, and frame metadata without requiring `UnityEngine` in tests.
