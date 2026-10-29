// Documented tracing setup of the comparison SDK: its browser tracing integration,
// which covers page loads, navigations, fetch and XHR spans, and Web Vitals.
import * as Sentry from "@sentry/browser";

Sentry.init({
  dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
  integrations: [Sentry.browserTracingIntegration()],
  tracePropagationTargets: [/^\/api\//],
  tracesSampleRate: 1.0
});
