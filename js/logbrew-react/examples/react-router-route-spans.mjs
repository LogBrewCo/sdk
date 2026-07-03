const sdk = await import("@logbrew/sdk").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../../logbrew-js/index.js");
  }
  throw error;
});

const reactSdk = await import("@logbrew/react").catch(async (error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    return import("../index.js");
  }
  throw error;
});

const { RecordingTransport } = sdk;
const {
  captureReactRouterNavigation,
  createLogBrewReactClient,
  createReactRouterRouteTemplate
} = reactSdk;

const client = createLogBrewReactClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "logbrew-react-router-example",
  sdkVersion: "0.1.0",
  maxRetries: 1
});

const routeMatches = [
  { route: { path: "/" } },
  { route: { path: "projects" } },
  { route: { path: ":projectId" }, params: { projectId: "private-project-123" } },
  { route: { path: "settings" } }
];

const routeTemplate = createReactRouterRouteTemplate(routeMatches);
const navigation = captureReactRouterNavigation(client, {
  durationMs: 37,
  location: {
    pathname: "/projects/private-project-123/settings",
    search: "?debug=true",
    hash: "#panel"
  },
  navigationType: "PUSH",
  routeMatches,
  timestamp: "2026-06-02T10:00:12Z",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"
});

const preview = client.previewJson();
if (
  preview.includes("private-project-123") ||
  preview.includes("debug=true") ||
  preview.includes("#panel")
) {
  throw new Error(`route span leaked concrete route details: ${preview}`);
}

const response = await client.shutdown(new RecordingTransport([{ statusCode: 503 }, { statusCode: 202 }]));

console.log(preview);
console.error(JSON.stringify({
  attempts: response.attempts,
  events: 1,
  ok: true,
  routeSpan: navigation.attributes.name,
  routeTemplate
}));
