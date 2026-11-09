/** True for non-null, non-array objects, including objects with custom prototypes. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True only for records whose prototype is `Object.prototype` or `null`. */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Create a null-prototype record with a working primitive coercion.
 *
 * Handlebars builds strict-mode errors with string concatenation; without the
 * hook, coercing a null-prototype object throws "No default value". The null
 * prototype also keeps strict mode from resolving `Object.prototype` names as
 * template variables.
 */
export const createNullRecord = (): Record<string, unknown> => {
  const record: Record<string, unknown> = Object.create(null);
  Object.defineProperty(record, Symbol.toPrimitive, {
    value: () => "[object Object]",
    enumerable: false,
  });
  return record;
};
