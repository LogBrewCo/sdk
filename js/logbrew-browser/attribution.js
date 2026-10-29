// First-touch campaign attribution for one browser tab session: the landing URL's UTM source,
// medium, and campaign, plus the referring site's host name. Nothing else from the URL or the
// referrer is read or kept.
const SESSION_ITEM = "logbrew.attribution.v1";
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign"];
const MAX_VALUE_LENGTH = 100;
const MAX_CONTEXT_TAGS = 32;

export function browserAttributionTags(browserWindow) {
  const storage = sessionStorageOf(browserWindow);
  const saved = readSaved(storage);
  if (saved !== undefined) {
    return saved;
  }
  const tags = {};
  const location = parseUrl(safeProperty(browserWindow, "location")?.href);
  for (const key of CAMPAIGN_KEYS) {
    const value = cleanValue(location?.searchParams.get(key));
    if (value !== undefined) {
      tags[key] = value;
    }
  }
  const referrer = parseUrl(safeProperty(safeProperty(browserWindow, "document"), "referrer"));
  if (referrer && (referrer.protocol === "https:" || referrer.protocol === "http:")
    && referrer.hostname && referrer.hostname !== location?.hostname) {
    tags.referrer_domain = referrer.hostname.toLowerCase();
  }
  try {
    storage?.setItem(SESSION_ITEM, JSON.stringify(tags));
  } catch {
    // Without session storage, every page reads its own landing URL and referrer.
  }
  return tags;
}

// App-supplied tags win; attribution is left out when the merged tags would exceed the limit.
export function addBrowserAttributionContext(context, tags) {
  if (Object.keys(tags).length === 0) {
    return context;
  }
  if (context === undefined) {
    return { schemaVersion: 1, tags };
  }
  if (!isRecord(context) || context.schemaVersion !== 1 || (context.tags !== undefined && !isRecord(context.tags))) {
    return context;
  }
  const merged = { ...tags, ...context.tags };
  return Object.keys(merged).length > MAX_CONTEXT_TAGS ? context : { ...context, tags: merged };
}

function readSaved(storage) {
  let text;
  try {
    text = storage?.getItem(SESSION_ITEM);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const tags = {};
    for (const key of [...CAMPAIGN_KEYS, "referrer_domain"]) {
      const value = cleanValue(parsed[key]);
      if (value !== undefined) {
        tags[key] = value;
      }
    }
    return tags;
  } catch {
    return undefined;
  }
}

function cleanValue(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > MAX_VALUE_LENGTH) {
    return undefined;
  }
  return /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? undefined : trimmed;
}

function parseUrl(value) {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function sessionStorageOf(browserWindow) {
  try {
    return browserWindow?.sessionStorage;
  } catch {
    return undefined;
  }
}

function safeProperty(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
