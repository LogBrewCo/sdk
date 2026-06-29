# React Native GraphQL Resource Metadata - 2026-06-29

## Target

Close a small React Native resource-span gap without adding Apollo, GraphQL, or
hidden global payload parsing. LogBrew already records app-owned fetch/XHR spans;
the missing piece was a safe way for apps to attach GraphQL operation name/type
when they already know it.

## Sources Read

- Datadog npm package
  `@datadog/mobile-react-native-apollo-client@3.5.2`, tarball
  `https://registry.npmjs.org/@datadog/mobile-react-native-apollo-client/-/mobile-react-native-apollo-client-3.5.2.tgz`:
  `src/DatadogLink.ts`, `src/helpers.ts`.
- OpenTelemetry npm package
  `@opentelemetry/instrumentation-graphql@0.67.0`, tarball
  `https://registry.npmjs.org/@opentelemetry/instrumentation-graphql/-/instrumentation-graphql-0.67.0.tgz`:
  `build/src/enums/AttributeNames.js`, `build/src/instrumentation.js`,
  `build/src/types.d.ts`.

## Patterns Observed

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

This intentionally does not copy Datadog's Apollo link or OTel's GraphQL module
patching. It does not parse GraphQL request content, capture variable values,
capture query source, add baggage/tracestate, or inspect arbitrary headers. Apps that already
know their operation can add low-cardinality metadata such as
`graphqlOperationName` and `graphqlOperationType`.

## Remaining Gap

Datadog and OpenTelemetry remain ahead for automatic Apollo/GraphQL
instrumentation. A future LogBrew package could add an app-owned Apollo link,
but it should keep the same default privacy posture: operation name/type only
unless the user explicitly opts into broader, reviewed metadata.
