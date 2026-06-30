# React Native GraphQL Resource Metadata - 2026-06-29

## Target

Close a small React Native resource-span gap without adding Apollo, GraphQL, or
hidden global payload parsing. LogBrew already records app-owned fetch/XHR spans;
the missing piece was a safe way for apps to attach GraphQL operation name/type
when they already know it.

## Sources Read

- Sentry React Native npm package `@sentry/react-native@8.16.0`, tarball
  `https://registry.npmjs.org/@sentry/react-native/-/react-native-8.16.0.tgz`
  from repo `getsentry/sentry-react-native`: `dist/js/integrations/graphql.js`,
  `dist/js/integrations/graphql.d.ts`, `dist/js/integrations/exports.js`.
- Datadog npm package
  `@datadog/mobile-react-native-apollo-client@3.5.2`, tarball
  `https://registry.npmjs.org/@datadog/mobile-react-native-apollo-client/-/mobile-react-native-apollo-client-3.5.2.tgz`:
  repo `DataDog/dd-sdk-reactnative` directory
  `packages/react-native-apollo-client`, npm `gitHead`
  `92462dccefd689815d87dabbad0d41572cd06cca`: `src/DatadogLink.ts`,
  `src/helpers.ts`, `src/index.ts`, `src/types.ts`,
  `src/__tests__/helpers.test.ts`.
- OpenTelemetry npm package
  `@opentelemetry/instrumentation-graphql@0.67.0`, tarball
  `https://registry.npmjs.org/@opentelemetry/instrumentation-graphql/-/instrumentation-graphql-0.67.0.tgz`:
  repo `open-telemetry/opentelemetry-js-contrib` directory
  `packages/instrumentation-graphql`, npm `gitHead`
  `4e52a9053029304f271b7dbe1b07e7fb2b987e30`:
  `build/src/enums/AttributeNames.js`, `build/src/instrumentation.js`,
  `build/src/types.d.ts`.

## Patterns Observed

- Sentry React Native exposes `graphqlIntegration(options)` with endpoint
  matching and delegates to the browser GraphQL client integration, keeping the
  setup small but still broader than LogBrew's previous app-owned fetch helper.
- Datadog's React Native Apollo link wraps Apollo operations and forwards
  operation type/name as Datadog headers. It can also opt into broader request
  data and error tracking.
- OpenTelemetry's GraphQL instrumentation records `graphql.operation.type` and
  `graphql.operation.name`, and has explicit config around values/source
  capture.

## LogBrew Choice

LogBrew now keeps the React Native helper app-owned and dependency-free:
`createReactNativeResourceFetch()` accepts `metadataFactory(context)`, called
after success/failure with method, sanitized route template, status/duration,
input/init, response, or error context. Only primitive return values are kept,
and sensitive request-field keys are dropped.

2026-06-30 follow-up: LogBrew now also exposes
`createReactNativeGraphQLMetadataFactory()` from
`@logbrew/react-native/resource-fetch`. Apps opt into this helper only for
GraphQL fetches they own. It reads a JSON string request body only to derive
`graphqlOperationName` and `graphqlOperationType`, ignores large/non-JSON
bodies, composes an existing primitive metadata factory, and drops variables,
query source, body fields, headers, baggage, tracestate, payloads, and
response data from emitted metadata.

This intentionally does not copy Datadog's Apollo link or OTel's GraphQL module
patching. It does not install Apollo/GraphQL dependencies, patch global
fetch/XHR by default, capture variable values, capture query source, add
baggage/tracestate, or inspect arbitrary headers.

2026-06-30 Apollo follow-up: LogBrew now adds
`createReactNativeApolloLink()` in `@logbrew/react-native/apollo`. Apps pass the
`ApolloLink` constructor they already use, so the default package still has no
Apollo dependency. The link records one sanitized `graphql.<type> <name>` span
on operation completion or transport error, writes one normalized `traceparent`
into Apollo operation context by default, and keeps primitive metadata only:
operation name/type, `framework=apollo-client`, `source=react-native.apollo`,
duration, trace IDs, and type-only errors. It avoids query text, variables,
payloads, response data, arbitrary headers, cookies, error messages, stacks,
baggage, tracestate, global fetch/XHR patching, and exporter ownership.

## Remaining Gap

Sentry and Datadog still have broader automatic mobile GraphQL/resource
instrumentation, and OpenTelemetry remains stronger for server-side GraphQL
module patching. LogBrew is now more privacy-bounded and lighter for app-owned
Apollo Client use, but still lacks endpoint-wide automatic GraphQL detection,
native symbolication, OTel baggage/tracestate, rich GraphQL resolver spans, and
backend-hosted release artifact symbolication.
