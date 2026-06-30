#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

core_pack_json="$tmp_dir/core-pack.json"
native_pack_json="$tmp_dir/native-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-react-native" && npm pack --json --pack-destination "$tmp_dir") > "$native_pack_json"

core_tgz="$tmp_dir/$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())[0]["filename"])
PY
)"
native_tgz="$tmp_dir/$(python3 - "$native_pack_json" <<'PY'
import json
import sys
from pathlib import Path

print(json.loads(Path(sys.argv[1]).read_text())[0]["filename"])
PY
)"
test -f "$core_tgz"
test -f "$native_tgz"

tar -tzf "$native_tgz" > "$tmp_dir/native-tarball.txt"
grep -q '^package/apollo.js$' "$tmp_dir/native-tarball.txt"
grep -q '^package/apollo.cjs$' "$tmp_dir/native-tarball.txt"
grep -q '^package/apollo.d.ts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/apollo.d.cts$' "$tmp_dir/native-tarball.txt"
grep -q '^package/examples/apollo-link-spans.mjs$' "$tmp_dir/native-tarball.txt"
tar -xOf "$native_tgz" package/README.md > "$tmp_dir/native-readme.md"
grep -q '@logbrew/react-native/apollo' "$tmp_dir/native-readme.md"
grep -q 'createReactNativeApolloLink' "$tmp_dir/native-readme.md"
grep -q 'propagateTraceparent: false' "$tmp_dir/native-readme.md"

app_dir="$tmp_dir/react-native-apollo-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null

react_native_version="$(npm view react-native version)"
react_version="$(npm view react version)"
apollo_version="$(npm view @apollo/client version)"
graphql_version="$(npm view graphql version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$native_tgz" \
  "react@$react_version" \
  "react-native@$react_native_version" \
  "@apollo/client@$apollo_version" \
  "graphql@$graphql_version" \
  typescript \
  @types/react \
  >/dev/null

grep -q '"./apollo"' node_modules/@logbrew/react-native/package.json
node --check node_modules/@logbrew/react-native/apollo.js
node --check node_modules/@logbrew/react-native/apollo.cjs
node -e 'const apollo = require("@logbrew/react-native/apollo"); if (typeof apollo.createReactNativeApolloLink !== "function" || typeof apollo.default !== "object") process.exit(1)'
node --input-type=module -e 'import apollo, { createReactNativeApolloLink } from "@logbrew/react-native/apollo"; if (typeof createReactNativeApolloLink !== "function" || typeof apollo.createReactNativeApolloLink !== "function") process.exit(1)'
npm ls @logbrew/sdk @logbrew/react-native @apollo/client graphql react react-native >/dev/null

cat > apollo-smoke.mjs <<'EOF'
import { ApolloLink, Observable, gql } from "@apollo/client/core";
import { RecordingTransport } from "@logbrew/sdk";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import {
  createReactNativeApolloLink
} from "@logbrew/react-native/apollo";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "react-native-apollo-installed-smoke",
  sdkVersion: "0.1.0",
  maxRetries: 1
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "d4ad6b7169206664"
});
let clock = 1000;
let timestampIndex = 0;
const link = createReactNativeApolloLink(client, {
  ApolloLink,
  metadata: { flow: "checkout" },
  metadataFactory(context) {
    return {
      feature: context.operationName,
      requestBody: "{ shouldNotShip }",
      variables: { email: "hidden@example.test" }
    };
  },
  now: () => `2026-06-30T08:20:${String(timestampIndex++).padStart(2, "0")}Z`,
  nowMs: () => {
    const value = clock;
    clock += 5;
    return value;
  },
  screen: "Checkout",
  sessionId: "session_mobile_001",
  trace
});

const query = gql`
  mutation CheckoutSubmit($email: String!) {
    checkout(email: $email) {
      id
    }
  }
`;
const operations = [];

function makeOperation(name) {
  let context = {
    headers: {
      accept: "application/json",
      authorization: "RedactedAuthHeader"
    }
  };
  const operation = {
    operationName: name,
    query,
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
  operations.push(operation);
  return operation;
}

function executeApollo(name, handler) {
  return new Promise((resolve, reject) => {
    const operation = makeOperation(name);
    link.request(operation, () => new Observable((observer) => {
      handler(observer);
      return () => {};
    })).subscribe({
      complete() {
        resolve({ operation });
      },
      error(error) {
        resolve({ error, operation });
      },
      next() {}
    });
  });
}

for (let index = 0; index < 40; index += 1) {
  await executeApollo(`CheckoutBatch${index}`, (observer) => {
    observer.next({ data: { checkout: { id: `order_${index}` } } });
    observer.complete();
  });
}
const failure = await executeApollo("CheckoutFailure", (observer) => {
  observer.error(new TypeError("private network URL https://api.example.test/graphql?debug=redacted"));
});
if (!(failure.error instanceof TypeError)) {
  throw new Error("expected Apollo failure to reach the caller");
}

const firstTraceparent = operations[0].getContext().headers.traceparent;
if (firstTraceparent !== `00-${trace.traceId}-${trace.spanId}-01`) {
  throw new Error(`unexpected Apollo traceparent: ${firstTraceparent}`);
}
const events = JSON.parse(client.previewJson()).events;
if (events.length !== 41) {
  throw new Error(`expected 41 Apollo spans, got ${events.length}`);
}
const first = events[0].attributes;
const last = events[events.length - 1].attributes;
if (
  first.name !== "graphql.mutation CheckoutBatch0" ||
  first.status !== "ok" ||
  first.durationMs !== 5 ||
  first.metadata.source !== "react-native.apollo" ||
  first.metadata.framework !== "apollo-client" ||
  first.metadata.graphqlOperationName !== "CheckoutBatch0" ||
  first.metadata.graphqlOperationType !== "mutation" ||
  first.metadata.traceId !== trace.traceId
) {
  throw new Error(`unexpected first Apollo span: ${JSON.stringify(first)}`);
}
if (
  last.name !== "graphql.mutation CheckoutFailure" ||
  last.status !== "error" ||
  last.metadata.errorName !== "TypeError" ||
  last.metadata.errorValueType !== "object" ||
  last.metadata.traceId !== trace.traceId
) {
  throw new Error(`unexpected failed Apollo span: ${JSON.stringify(last)}`);
}
const serialized = JSON.stringify(events);
for (const forbidden of ["hidden@example.test", "shouldNotShip", "debug=redacted", "RedactedAuthHeader"]) {
  if (serialized.includes(forbidden)) {
    throw new Error(`Apollo span leaked sensitive value: ${forbidden}`);
  }
}

const response = await client.shutdown(RecordingTransport.alwaysAccept());
console.log(JSON.stringify({
  ok: true,
  events: events.length,
  status: response.statusCode,
  firstSpan: first.name,
  failureSpan: last.name,
  propagatedTraceparent: firstTraceparent,
  traceId: trace.traceId
}));
EOF
node apollo-smoke.mjs > "$tmp_dir/apollo-smoke.stdout.json"
grep -q '"events":41' "$tmp_dir/apollo-smoke.stdout.json"
grep -q '"firstSpan":"graphql.mutation CheckoutBatch0"' "$tmp_dir/apollo-smoke.stdout.json"
grep -q '"failureSpan":"graphql.mutation CheckoutFailure"' "$tmp_dir/apollo-smoke.stdout.json"
grep -q '"propagatedTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-d4ad6b7169206664-01"' "$tmp_dir/apollo-smoke.stdout.json"

cat > consumer.ts <<'EOF'
import { ApolloLink } from "@apollo/client/core";
import {
  createLogBrewReactNativeClient,
  createReactNativeTraceContext
} from "@logbrew/react-native";
import {
  createReactNativeApolloLink,
  type ReactNativeApolloLinkOptions
} from "@logbrew/react-native/apollo";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "typed-react-native-apollo",
  sdkVersion: "0.1.0"
});
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "d4ad6b7169206664"
});
const options: ReactNativeApolloLinkOptions<ApolloLink> = {
  ApolloLink,
  trace,
  metadataFactory(context) {
    return { operationName: context.operationName ?? "unknown" };
  }
};
const link: ApolloLink = createReactNativeApolloLink(client, options);
void link;
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

node node_modules/@logbrew/react-native/examples/index.mjs apollo-link-spans > "$tmp_dir/example-apollo.stdout.json" 2> "$tmp_dir/example-apollo.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/example-apollo.stdout.json" >/dev/null
grep -q '"events":2' "$tmp_dir/example-apollo.stderr.json"
grep -q '"successSpan":"graphql.mutation CheckoutSubmit"' "$tmp_dir/example-apollo.stderr.json"
grep -q '"failureSpan":"graphql.mutation CheckoutRetry"' "$tmp_dir/example-apollo.stderr.json"
npm --prefix node_modules/@logbrew/react-native/examples run --silent apollo-link-spans > "$tmp_dir/npm-example-apollo.stdout.json" 2> "$tmp_dir/npm-example-apollo.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-example-apollo.stdout.json" >/dev/null
grep -q '"events":2' "$tmp_dir/npm-example-apollo.stderr.json"

echo "React Native Apollo installed-artifact smoke passed"
