/** Truncate a string to a maximum number of Unicode code points. */
export const clip = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
};

/** Clip a model-provided string, trimming surrounding whitespace and rejecting blank input. */
export const clipText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = clip(value.trim(), max)?.trim();
  return text && text.length > 0 ? text : undefined;
};

/** Clip a string while preserving an intentionally empty value, such as a separator. */
export const clipAllowEmpty = (value: string, max: number): string => {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
};
