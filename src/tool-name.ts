export const MAX_TOOL_NAME_LENGTH = 128;

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One dot-separated namespace segment; same grammar as an effective tool name. */
export const NAMESPACE_SEGMENT_PATTERN = TOOL_NAME_PATTERN;

const UNSUPPORTED_TOOL_NAME_CHARACTERS = /[^A-Za-z0-9_-]/g;

export const normalizeToolName = (value: string): string =>
  value.replace(UNSUPPORTED_TOOL_NAME_CHARACTERS, "_");

export const isEffectiveToolName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_TOOL_NAME_LENGTH &&
  TOOL_NAME_PATTERN.test(value);

export const effectiveToolName = (
  namespace: string | undefined,
  name: string,
): string => {
  const normalized = normalizeToolName(name);
  return namespace === undefined
    ? normalized
    : `${namespace.replaceAll(".", "_")}_${normalized}`;
};
