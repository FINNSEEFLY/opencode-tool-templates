import { isRecord } from "./record";
import { clipAllowEmpty, clipText } from "./text";
import {
  MAX_TOOL_NAME_LENGTH,
  NAMESPACE_SEGMENT_PATTERN,
  isEffectiveToolName,
} from "./tool-name";

export const DEFAULT_NAMESPACE = "template";
export const MAX_NAMESPACE_LENGTH = 64;
export const DEFAULT_SEPARATOR = "\n\n";
export const MAX_SEPARATOR_LENGTH = 1024;
export const DEFAULT_SKIP_EMPTY = true;
export const DEFAULT_ALLOW_HARD_LINKED_TEMPLATES = false;
export const DEFAULT_REGISTER_SKILL = true;
export const DEFAULT_TEMPLATE_PATHS: readonly string[] = ["**/*"];
export const DEFAULT_BUILD_PATHS: readonly string[] = ["**/*"];
export const MAX_PATH_PATTERNS = 64;
export const MAX_PATH_PATTERN_LENGTH = 1024;
export const MAX_TOOL_NAMES = 200;

export const OUTPUT_FORMAT = {
  text: "text",
  json: "json",
} as const;

export type OutputFormat = (typeof OUTPUT_FORMAT)[keyof typeof OUTPUT_FORMAT];

export const OUTPUT_FORMATS: readonly OutputFormat[] = Object.values(OUTPUT_FORMAT);

export const DEFAULT_ALLOWED_OUTPUT_FORMATS: readonly OutputFormat[] = OUTPUT_FORMATS;

export const isOutputFormat = (value: unknown): value is OutputFormat =>
  typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value);

export const normalizeOutputFormats = (value: unknown): readonly OutputFormat[] => {
  if (!Array.isArray(value)) return DEFAULT_ALLOWED_OUTPUT_FORMATS;
  const allowed = new Set<OutputFormat>();
  for (const item of value) {
    if (isOutputFormat(item)) allowed.add(item);
  }
  if (allowed.size === 0) return DEFAULT_ALLOWED_OUTPUT_FORMATS;
  return OUTPUT_FORMATS.filter((format) => allowed.has(format));
};

export const LIMIT_SPECS = {
  /** Maximum bytes accepted from one template source (inline or file). */
  maxTemplateBytes: { default: 1_048_576, min: 1024, max: 10_485_760 },
  /** Maximum bytes of rendered target arguments per call. */
  maxRenderedBytes: { default: 2_097_152, min: 1024, max: 20_971_520 },
  /** Maximum parts in one flat template chain. */
  maxChainParts: { default: 100, min: 1, max: 500 },
} as const;

export type LimitKey = keyof typeof LIMIT_SPECS;

export const LIMIT_KEYS = Object.keys(LIMIT_SPECS) as readonly LimitKey[];

export type Limits = { [Key in LimitKey]?: number };

export type ResolvedLimits = { [Key in LimitKey]: number };

export interface Options {
  /** Tool namespace; tools become `<namespace>_call` and `<namespace>_build`. */
  namespace?: string;
  /**
   * Glob patterns allowed for `$file` templates. Relative patterns resolve
   * from the project directory. An empty array disables file templates.
   */
  templatePaths?: readonly string[];
  /**
   * Glob patterns allowed for `template_build` file output. Relative patterns
   * resolve from the project directory. An empty array disables file output.
   */
  buildPaths?: readonly string[];
  /**
   * Allow `$file` templates with multiple hard links. Defaults to false.
   * Enabling this weakens the path allowlist boundary.
   */
  allowHardLinkedTemplates?: boolean;
  /** Effective tool names that `template_call` may target. Empty allows all. */
  allowedTools?: readonly string[];
  /** Effective tool names that `template_call` must never target. */
  deniedTools?: readonly string[];
  /** Default separator between `$parts` items. */
  defaultSeparator?: string;
  /** Default for skipping empty `$parts` items. */
  defaultSkipEmpty?: boolean;
  /** Output formats `template_call` may return. */
  allowedOutputFormats?: readonly string[];
  /** Register the bundled SKILL.md as a model-facing skill. Defaults to true. */
  registerSkill?: boolean;
  /** Optional tuning limits. */
  limits?: Limits;
}

export interface Config {
  namespace: string;
  templatePaths: readonly string[];
  buildPaths: readonly string[];
  allowHardLinkedTemplates: boolean;
  allowedTools: readonly string[];
  deniedTools: readonly string[];
  defaultSeparator: string;
  defaultSkipEmpty: boolean;
  allowedOutputFormats: readonly OutputFormat[];
  registerSkill: boolean;
  limits: ResolvedLimits;
}

/** Deny matching is case-insensitive; allow matching stays exact. */
export const isDeniedTool = (config: Config, name: string): boolean => {
  const normalized = name.toLowerCase();
  return config.deniedTools.some((entry) => entry.toLowerCase() === normalized);
};

const CONFIG_KEY_MAP = {
  namespace: true,
  templatePaths: true,
  buildPaths: true,
  allowHardLinkedTemplates: true,
  allowedTools: true,
  deniedTools: true,
  defaultSeparator: true,
  defaultSkipEmpty: true,
  allowedOutputFormats: true,
  registerSkill: true,
  limits: true,
} as const satisfies Record<keyof Options, true>;

/** Every accepted top-level option key. Unknown keys fail configuration resolution. */
export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(CONFIG_KEY_MAP));

const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);

const SUGGESTION_MAX_DISTANCE = 2;

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
};

const nearestKey = (key: string, known: ReadonlySet<string>): string | undefined => {
  let nearest: string | undefined;
  let nearestDistance = SUGGESTION_MAX_DISTANCE + 1;
  for (const candidate of known) {
    if (candidate === key) continue;
    const distance = editDistance(key, candidate);
    if (distance >= nearestDistance) continue;
    nearest = candidate;
    nearestDistance = distance;
  }
  return nearest;
};

const rejectUnknownKeys = (
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  label: string,
  knownLabel: string,
): void => {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (known.has(key)) continue;
    const suggestion = nearestKey(key, known);
    const hint = suggestion ? ` Did you mean ${JSON.stringify(suggestion)}?` : "";
    throw new Error(
      `Unknown ${label} ${JSON.stringify(key)}.${hint} Known ${knownLabel}: ${[...known].join(", ")}.`,
    );
  }
};

const readOption = (options: Record<string, unknown>, key: keyof Options): unknown =>
  Object.hasOwn(options, key) ? options[key] : undefined;

/** Accept booleans as-is; ignore other types and fall back to the documented default. */
const resolveBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const resolveSeparator = (value: unknown): string =>
  typeof value === "string"
    ? clipAllowEmpty(value, MAX_SEPARATOR_LENGTH)
    : DEFAULT_SEPARATOR;

const limitInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const normalizeStringList = (
  value: readonly unknown[],
  maxEntries: number,
  maxLength: number,
): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = clipText(item, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxEntries) break;
  }
  return result;
};

const normalizePatterns = (
  value: unknown,
  option: string,
  fallback: readonly string[] = DEFAULT_TEMPLATE_PATHS,
): readonly string[] => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    throw new Error(`${option} must be an array of glob patterns.`);
  }
  return normalizeStringList(value, MAX_PATH_PATTERNS, MAX_PATH_PATTERN_LENGTH);
};

const normalizeToolNames = (value: unknown, option: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${option} must be an array of tool names.`);
  }
  if (value.length > MAX_TOOL_NAMES) {
    throw new Error(`${option} must contain at most ${MAX_TOOL_NAMES} entries.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${option} entries must be strings.`);
    }
    const name = item.trim();
    if (name.length === 0) {
      throw new Error(`${option} entries must not be empty.`);
    }
    if (name.length > MAX_TOOL_NAME_LENGTH) {
      throw new Error(
        `${option} entries must be at most ${MAX_TOOL_NAME_LENGTH} characters.`,
      );
    }
    if (!isEffectiveToolName(name)) {
      throw new Error(`${option} entry "${name}" is not a valid target name.`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
};

const resolveNamespace = (value: unknown): string => {
  const namespace = clipText(value, MAX_NAMESPACE_LENGTH) ?? DEFAULT_NAMESPACE;
  if (!namespace.split(".").every((segment) => NAMESPACE_SEGMENT_PATTERN.test(segment))) {
    throw new Error(
      `namespace must contain only letters, digits, underscores, hyphens, and dots: ${namespace}`,
    );
  }
  return namespace;
};

const resolveLimits = (value: unknown): ResolvedLimits => {
  const raw = value === undefined ? {} : value;
  if (!isRecord(raw)) {
    throw new Error("limits must be an object.");
  }
  rejectUnknownKeys(raw, LIMIT_KEY_SET, "limits option", "limits");
  const resolved = {} as ResolvedLimits;
  for (const key of LIMIT_KEYS) {
    const spec = LIMIT_SPECS[key];
    resolved[key] = limitInteger(
      Object.hasOwn(raw, key) ? raw[key] : undefined,
      spec.default,
      spec.min,
      spec.max,
    );
  }
  return resolved;
};

export const resolveConfig = (raw: unknown): Config => {
  // OpenCode passes undefined when the plugin entry has no options.
  const options = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(options)) {
    throw new Error("Plugin options must be an object.");
  }
  rejectUnknownKeys(options, CONFIG_KEYS, "plugin option", "options");
  return {
    namespace: resolveNamespace(readOption(options, "namespace")),
    templatePaths: normalizePatterns(
      readOption(options, "templatePaths"),
      "templatePaths",
    ),
    buildPaths: normalizePatterns(
      readOption(options, "buildPaths"),
      "buildPaths",
      DEFAULT_BUILD_PATHS,
    ),
    allowHardLinkedTemplates: resolveBoolean(
      readOption(options, "allowHardLinkedTemplates"),
      DEFAULT_ALLOW_HARD_LINKED_TEMPLATES,
    ),
    allowedTools: normalizeToolNames(readOption(options, "allowedTools"), "allowedTools"),
    deniedTools: normalizeToolNames(readOption(options, "deniedTools"), "deniedTools"),
    defaultSeparator: resolveSeparator(readOption(options, "defaultSeparator")),
    defaultSkipEmpty: resolveBoolean(
      readOption(options, "defaultSkipEmpty"),
      DEFAULT_SKIP_EMPTY,
    ),
    allowedOutputFormats: normalizeOutputFormats(
      readOption(options, "allowedOutputFormats"),
    ),
    registerSkill: resolveBoolean(
      readOption(options, "registerSkill"),
      DEFAULT_REGISTER_SKILL,
    ),
    limits: resolveLimits(readOption(options, "limits")),
  };
};
