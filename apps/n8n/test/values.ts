type Fields = Readonly<Record<string, unknown>>;

const firstIndex = 0;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value.at(firstIndex) : undefined;
}

function outputOf(result: unknown): readonly Fields[] {
  const items = firstOf(result);
  if (!Array.isArray(items)) {
    throw new TypeError("no output items");
  }
  return items.map((item: unknown) => fieldsOf(item));
}

function jsonOf(item: Fields | undefined): Fields {
  return fieldsOf(item?.["json"]);
}

function pick(result: unknown, keys: readonly string[]): readonly (readonly unknown[])[] {
  return outputOf(result).map((item) => keys.map((key) => jsonOf(item)[key]));
}

export { type Fields, fieldsOf, firstIndex, firstOf, jsonOf, outputOf, pick };
