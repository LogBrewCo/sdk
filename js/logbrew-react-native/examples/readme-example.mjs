import { RecordingTransport } from "@logbrew/sdk";
import {
  captureScreenView,
  createLogBrewReactNativeClient
} from "@logbrew/react-native";

const fakePlatform = {
  OS: "ios",
  Version: "18.0",
  isPad: false,
  constants: { isTesting: true }
};
const fakeAppState = { currentState: "active" };
const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-readme-example",
  sdkVersion: "0.1.0"
});

addFullBatch(client);
captureScreenView(client, "Checkout", {
  id: "evt_action_001",
  timestamp: "2026-06-02T10:00:05Z",
  platform: fakePlatform,
  appState: fakeAppState,
  metadata: { flow: "checkout" }
});

console.log(client.previewJson());
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));

function addFullBatch(client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", {
    version: "1.2.3",
    commit: "abc123def456",
    notes: "Public release marker"
  });
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
    name: "production",
    region: "global"
  });
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
    title: "Checkout timeout",
    level: "error",
    message: "Request timed out after retry budget"
  });
  client.log("evt_log_001", "2026-06-02T10:00:03Z", {
    message: "worker started",
    level: "info",
    logger: "job-runner"
  });
  client.span("evt_span_001", "2026-06-02T10:00:04Z", {
    name: "GET /health",
    traceId: "trace_001",
    spanId: "span_001",
    status: "ok",
    durationMs: 12.5
  });
}
