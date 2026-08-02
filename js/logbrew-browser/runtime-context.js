const MAX_CONTEXT_STRING_LENGTH = 256;
const CONTEXT_SECTIONS = new Set(["resource", "trace", "session", "subject", "tags"]);

export function addBrowserRuntimeContext(context, browserNavigator = defaultNavigator()) {
  const defaultContext = createBrowserRuntimeContext(browserNavigator);
  if (context === undefined) {
    return defaultContext;
  }
  if (!isRecord(context)
    || context.schemaVersion !== 1
    || !Object.keys(context).some((key) => CONTEXT_SECTIONS.has(key))) {
    return context;
  }
  if (context.resource === undefined) {
    return { ...context, resource: defaultContext.resource };
  }
  if (!isRecord(context.resource) || Object.keys(context.resource).length === 0) {
    return context;
  }
  if (isRecord(context.resource.device) && Object.keys(context.resource.device).length === 0) {
    return context;
  }

  const resource = { ...defaultContext.resource, ...context.resource };
  if (isRecord(context.resource.device)) {
    resource.device = {
      ...(defaultContext.resource.device ?? {}),
      ...context.resource.device
    };
  }
  return { ...context, resource };
}

function createBrowserRuntimeContext(browserNavigator) {
  const userAgentData = safeProperty(browserNavigator, "userAgentData");
  const selectedBrand = selectBrowserBrand(userAgentData);
  const runtime = selectedBrand === undefined
    ? { name: "browser" }
    : selectedBrand;
  const resource = { runtime };

  const platform = boundedProbe(() => safeProperty(userAgentData, "platform"));
  if (platform !== undefined) {
    resource.operatingSystem = { name: platform };
  }

  const mobile = safeProperty(userAgentData, "mobile");
  if (typeof mobile === "boolean") {
    resource.device = { family: mobile ? "mobile" : "desktop" };
  }
  return { schemaVersion: 1, resource };
}

function selectBrowserBrand(userAgentData) {
  const brands = safeProperty(userAgentData, "brands");
  if (!Array.isArray(brands)) {
    return undefined;
  }
  const candidates = [];
  for (const entry of brands) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = boundedProbe(() => safeProperty(entry, "brand"));
    if (name === undefined || isGreaseBrand(name)) {
      continue;
    }
    const version = boundedProbe(() => safeProperty(entry, "version"));
    candidates.push(version === undefined ? { name } : { name, version });
  }
  return candidates.find(({ name }) => name.toLowerCase() !== "chromium") ?? candidates[0];
}

function isGreaseBrand(value) {
  const normalizedBrandKey = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalizedBrandKey.startsWith("not") && normalizedBrandKey.endsWith("brand");
}

function boundedProbe(probe) {
  try {
    const value = probe();
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    if (!normalized || Array.from(normalized).length > MAX_CONTEXT_STRING_LENGTH) {
      return undefined;
    }
    return Array.from(normalized).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || (code >= 127 && code <= 159));
    })
      ? undefined
      : normalized;
  } catch {
    return undefined;
  }
}

function safeProperty(value, key) {
  try {
    return isRecord(value) ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function defaultNavigator() {
  try {
    return globalThis.navigator;
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
