import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import {
  createReactNativeApolloLink
} from "@logbrew/react-native/apollo";

class ApolloLink {
  constructor(request) {
    this.request = request;
  }
}

function observableFrom(handler) {
  return {
    subscribe(observer) {
      handler(observer);
      return { unsubscribe() {} };
    }
  };
}

let context = {
  headers: {
    accept: "application/json",
    authorization: "RedactedAuthHeader"
  }
};
const operation = {
  operationName: "CheckoutSubmit",
  query: {
    definitions: [
      { kind: "OperationDefinition", operation: "mutation" }
    ]
  },
  getContext() {
    return context;
  },
  setContext(nextContext) {
    const resolved = typeof nextContext === "function" ? nextContext(context) : nextContext;
    context = {
      ...context,
      ...resolved,
      headers: {
        ...(context.headers ?? {}),
        ...(resolved?.headers ?? {})
      }
    };
  }
};

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-native-apollo-link-spans",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "c3ad6b7169205553"
});
const times = [1000, 1041, 2000, 2027];
const timestamps = [
  "2026-06-30T08:10:00Z",
  "2026-06-30T08:10:01Z"
];
const link = createReactNativeApolloLink(client, {
  ApolloLink,
  metadata: { flow: "checkout" },
  metadataFactory(details) {
    return {
      feature: details.operationName,
      requestBody: "{ redacted }",
      variables: { email: "hidden@example.test" }
    };
  },
  now: () => timestamps.shift(),
  nowMs: () => times.shift(),
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace
});

link.request(operation, () => observableFrom((observer) => {
  observer.next({ data: { checkout: { id: "order_123" } } });
  observer.complete();
})).subscribe({});

link.request({
  ...operation,
  operationName: "CheckoutRetry"
}, () => observableFrom((observer) => {
  observer.error(new TypeError("network request failed with private marker"));
})).subscribe({
  error() {}
});

const events = JSON.parse(client.previewJson()).events;
if (events.length !== 2) {
  throw new Error(`expected two Apollo spans, got ${events.length}`);
}
if (operation.getContext().headers.traceparent !== `00-${trace.traceId}-${trace.spanId}-01`) {
  throw new Error(`expected Apollo traceparent, got ${operation.getContext().headers.traceparent}`);
}
const success = events[0].attributes;
const failure = events[1].attributes;
if (
  success.name !== "graphql.mutation CheckoutSubmit" ||
  success.status !== "ok" ||
  success.durationMs !== 41 ||
  success.metadata.source !== "react-native.apollo" ||
  success.metadata.framework !== "apollo-client" ||
  success.metadata.graphqlOperationName !== "CheckoutSubmit" ||
  success.metadata.graphqlOperationType !== "mutation" ||
  success.metadata.feature !== "CheckoutSubmit" ||
  success.metadata.requestBody !== undefined ||
  success.metadata.variables !== undefined ||
  success.metadata.traceId !== trace.traceId
) {
  throw new Error(`unexpected Apollo success span: ${JSON.stringify(success)}`);
}
if (
  failure.name !== "graphql.mutation CheckoutRetry" ||
  failure.status !== "error" ||
  failure.durationMs !== 27 ||
  failure.metadata.errorName !== "TypeError" ||
  failure.metadata.errorValueType !== "object" ||
  failure.metadata.traceId !== trace.traceId
) {
  throw new Error(`unexpected Apollo failure span: ${JSON.stringify(failure)}`);
}
if (JSON.stringify(events).includes("hidden@example.test") || JSON.stringify(events).includes("private marker")) {
  throw new Error("Apollo GraphQL span leaked variables or error message");
}

const preview = client.previewJson();
const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(preview);
console.error(JSON.stringify({
  ok: true,
  events: events.length,
  status: response.statusCode,
  successSpan: success.name,
  failureSpan: failure.name,
  propagatedTraceparent: operation.getContext().headers.traceparent,
  traceId: trace.traceId
}));
