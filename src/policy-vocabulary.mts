type JsonObject = Record<string, unknown>;

const OMIT = Symbol("retired-policy-variant");

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveLocalRef(rootSchema: JsonObject, rawSchema: unknown): JsonObject {
  let schema = object(rawSchema);
  const seen = new Set<string>();
  while (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const ref = schema.$ref;
    if (seen.has(ref)) throw new Error(`circular local schema reference: ${ref}`);
    seen.add(ref);
    let value: unknown = rootSchema;
    for (const token of ref.slice(2).split("/")) value = object(value)[decodePointerToken(token)];
    schema = object(value);
  }
  return schema;
}

function discriminatedVariant(rootSchema: JsonObject, rawSchema: unknown, value: unknown): JsonObject | typeof OMIT | null {
  const schema = resolveLocalRef(rootSchema, rawSchema);
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf.map((variant) => resolveLocalRef(rootSchema, variant))
    : [];
  if (!variants.length || !value || typeof value !== "object" || Array.isArray(value)) return null;

  const variantConstants = variants.map((variant) => Object.entries(object(variant.properties))
    .filter(([, property]) => Object.hasOwn(object(property), "const"))
    .map(([key, property]) => [key, object(property).const] as const));
  const candidateKeys = variantConstants[0]?.map(([key]) => key) ?? [];
  for (const key of candidateKeys) {
    if (!variantConstants.every((entries) => entries.some(([candidate]) => candidate === key))) continue;
    const constants = variantConstants.map((entries) => entries.find(([candidate]) => candidate === key)![1]);
    if (new Set(constants.map((item) => JSON.stringify(item))).size !== variants.length) continue;
    const actual = (value as JsonObject)[key];
    const index = constants.findIndex((expected) => Object.is(expected, actual));
    return index < 0 ? OMIT : variants[index]!;
  }
  return null;
}

function projectValue(rootSchema: JsonObject, rawSchema: unknown, value: unknown): unknown {
  const schema = resolveLocalRef(rootSchema, rawSchema);
  const variant = discriminatedVariant(rootSchema, schema, value);
  if (variant === OMIT) return OMIT;
  if (variant) return projectValue(rootSchema, variant, value);

  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (!itemSchema) return value;
    return value
      .map((item) => projectValue(rootSchema, itemSchema, item))
      .filter((item) => item !== OMIT);
  }

  if (value && typeof value === "object") {
    const projected: JsonObject = { ...(value as JsonObject) };
    const properties = object(schema.properties);
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(projected, key)) continue;
      const child = projectValue(rootSchema, propertySchema, projected[key]);
      if (child !== OMIT) projected[key] = child;
    }
    return projected;
  }

  return value;
}

/**
 * Historical BASE policy is evidence, not a legacy runtime contract.
 *
 * Keep only top-level concepts known by the current public schema and remove
 * whole discriminated variants that no longer exist in that schema. Shapes of
 * still-recognized variants are deliberately left intact so normal strict
 * schema + semantic compilation continues to fail closed on malformed current
 * constraints.
 */
export function projectPolicyToCurrentVocabulary(rawPolicy: unknown, rawCurrentSchema: unknown): unknown {
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) return rawPolicy;
  const rootSchema = object(rawCurrentSchema);
  const schema = resolveLocalRef(rootSchema, rootSchema);
  const properties = object(schema.properties);
  const projected: JsonObject = {};
  for (const [key, value] of Object.entries(rawPolicy as JsonObject)) {
    if (!Object.hasOwn(properties, key)) continue;
    const child = projectValue(rootSchema, properties[key], value);
    if (child !== OMIT) projected[key] = child;
  }
  return projected;
}
