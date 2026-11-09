import Handlebars from "handlebars";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { errorMessage } from "./errors";
import { createNullRecord } from "./record";

interface CustomHelperSpec {
  readonly kind: "custom";
  readonly min: number;
  readonly max: number | undefined;
  readonly run: (args: unknown[]) => unknown;
}

type HelperSpec =
  | { readonly kind: "builtin" }
  | { readonly kind: "disabled" }
  | CustomHelperSpec;

/** One spec per helper; names, known-helper flags, arity, and registration derive from it. */
export const HELPER_SPECS = {
  if: { kind: "builtin" },
  unless: { kind: "builtin" },
  each: { kind: "builtin" },
  with: { kind: "builtin" },
  lookup: { kind: "builtin" },
  json: {
    kind: "custom",
    min: 1,
    max: 1,
    run: ([value]) => JSON.stringify(value, null, 2) ?? "null",
  },
  join: {
    kind: "custom",
    min: 1,
    max: 2,
    run: ([value, separator]) => {
      if (!Array.isArray(value)) throw new Error("join expects an array");
      return value.join(typeof separator === "string" ? separator : ",");
    },
  },
  eq: { kind: "custom", min: 2, max: 2, run: ([left, right]) => left === right },
  ne: { kind: "custom", min: 2, max: 2, run: ([left, right]) => left !== right },
  and: {
    kind: "custom",
    min: 2,
    max: undefined,
    run: (values) => values.every(Boolean),
  },
  or: {
    kind: "custom",
    min: 2,
    max: undefined,
    run: (values) => values.some(Boolean),
  },
  not: { kind: "custom", min: 1, max: 1, run: ([value]) => !value },
  log: { kind: "disabled" },
} satisfies Record<string, HelperSpec>;

export const HELPER_NAMES = Object.entries(HELPER_SPECS)
  .filter(([, spec]) => spec.kind !== "disabled")
  .map(([name]) => name);

const CUSTOM_HELPERS: Record<string, boolean> = {};
for (const [name, spec] of Object.entries(HELPER_SPECS)) {
  if (spec.kind === "custom") CUSTOM_HELPERS[name] = true;
  else if (spec.kind === "disabled") CUSTOM_HELPERS[name] = false;
}

const env = Handlebars.create();
for (const [name, spec] of Object.entries(HELPER_SPECS)) {
  if (spec.kind === "disabled") {
    delete env.helpers[name];
  } else if (spec.kind === "custom") {
    env.registerHelper(name, (...args: unknown[]) =>
      spec.run(helperArgs(name, args, spec.min, spec.max)),
    );
  }
}

// Match Handlebars partial failures, not any message that contains the word
// "partial" (for example a missing variable named `partials`).
const PARTIAL_ERROR =
  /\bpartial\b.*\bcould not be (?:found|compiled)\b|\bUnsupported number of partial arguments\b/i;

const namedArgumentKeys = (args: unknown[]): string[] => {
  const options = args.at(-1);
  if (typeof options !== "object" || options === null) return [];
  if (!Object.hasOwn(options, "hash")) return [];
  const hash = (options as { hash?: unknown }).hash;
  if (typeof hash !== "object" || hash === null) return [];
  return Object.keys(hash);
};

const helperArgs = (
  name: string,
  args: unknown[],
  min: number,
  max?: number,
): unknown[] => {
  const named = namedArgumentKeys(args);
  if (named.length > 0) {
    throw new Error(`${name} does not accept named arguments: ${named.join(", ")}`);
  }
  const real = args.slice(0, -1);
  if (real.length < min || (max !== undefined && real.length > max)) {
    const expected =
      max === undefined ? `at least ${min}` : min === max ? `${min}` : `${min}-${max}`;
    throw new Error(`${name} expects ${expected} argument${expected === "1" ? "" : "s"}`);
  }
  return real;
};

const copyEntries = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
};

const createContext = (params: Record<string, unknown>) => {
  const context = createNullRecord();
  copyEntries(context, params);
  const namespace = createNullRecord();
  copyEntries(namespace, params);
  context.$params = namespace;
  return context;
};

const RAW_LOCATION = /\s+-\s+\d+:\d+\s*$/;
const MISSING_VARIABLE = /"([^"]+)" not defined\b/;
const UNKNOWN_HELPER = /\bunknown helper\s+#?([^\s]+)/i;

const collisionHint = (name: string): string =>
  `A parameter named "${name}" collides with the Handlebars helper "${name}". Use {{$params.${name}}} or rename the parameter.`;

const helperCollisionHint = (
  message: string,
  params: Record<string, unknown>,
): string | undefined => {
  // Unknown-helper messages must match the exact name: `iffy` is not `if`.
  const unknown = UNKNOWN_HELPER.exec(message);
  if (unknown) {
    const name = unknown[1];
    return HELPER_NAMES.includes(name) && Object.hasOwn(params, name)
      ? collisionHint(name)
      : undefined;
  }
  for (const name of HELPER_NAMES) {
    if (!Object.hasOwn(params, name)) continue;
    const patterns = [
      `#${name}`,
      `helper "${name}"`,
      `helper '${name}'`,
      `${name} expects`,
    ];
    if (patterns.some((pattern) => message.includes(pattern))) {
      return collisionHint(name);
    }
  }
  return undefined;
};

const errorLine = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const line = (error as { lineNumber?: unknown }).lineNumber;
  return typeof line === "number" && Number.isInteger(line) && line > 0
    ? line
    : undefined;
};

const locationSuffix = (line: number | undefined): string =>
  line === undefined ? "" : ` (line ${line})`;

const stripInternals = (message: string): string =>
  message
    .replace(RAW_LOCATION, "")
    .replaceAll("[object Object]", "the template context")
    .replaceAll("knownHelpersOnly", "the helper allowlist");

const appendLocation = (detail: string, line: number | undefined): string =>
  line === undefined || /\(line \d+\)/.test(detail) ? detail : `${detail} (line ${line})`;

const formatRenderErrorDetail = (
  error: unknown,
  params: Record<string, unknown>,
): string => {
  const raw = errorMessage(error);
  const line = errorLine(error);
  const location = locationSuffix(line);
  const hints: string[] = [];
  const collision = helperCollisionHint(raw, params);
  if (collision) hints.push(collision);

  const missing = MISSING_VARIABLE.exec(raw);
  if (missing) {
    const name = missing[1];
    hints.push(
      `If it is a parameter, pass it in $params; use {{$params.${name}}} if the name collides with a helper.`,
    );
    return `"${name}" is not defined${location}. ${hints.join(" ")}`;
  }

  const unknown = UNKNOWN_HELPER.exec(raw);
  if (unknown) {
    hints.push(`Allowed helpers: ${HELPER_NAMES.join(", ")}.`);
    return `Unknown helper "${unknown[1]}"${location}. ${hints.join(" ")}`;
  }

  if (PARTIAL_ERROR.test(raw)) {
    const detail = `Partials are not supported${location}.`;
    return hints.length > 0 ? `${detail} ${hints.join(" ")}` : detail;
  }

  const detail = appendLocation(stripInternals(raw), line);
  return hints.length > 0 ? `${detail}\n\n${hints.join("\n")}` : detail;
};

export interface RenderErrorOptions {
  /**
   * Chain parts add their own `Chain part ... failed:` prefix. Disable the
   * template prefix there so a failure is reported exactly once.
   */
  wrapErrors?: boolean;
}

/** Format one Handlebars failure, optionally with its template source prefix. */
export const formatRenderError = (
  error: unknown,
  params: Record<string, unknown>,
  label: string,
  options: RenderErrorOptions = {},
): string => {
  const detail = formatRenderErrorDetail(error, params);
  return options.wrapErrors === false ? detail : `Template ${label} failed: ${detail}`;
};

/**
 * Compile and render one Handlebars source. Plain values are handled by the
 * chain renderer; this function only sees explicit template sources.
 */
export const renderTemplate = (
  source: string,
  params: Record<string, unknown>,
  label: string,
  options: RenderErrorOptions = {},
): string => {
  try {
    const template = env.compile(source, {
      strict: true,
      noEscape: true,
      knownHelpersOnly: true,
      knownHelpers: CUSTOM_HELPERS,
    });
    return template(createContext(params));
  } catch (error) {
    throw new ToolError({
      message: formatRenderError(error, params, label, options),
      error,
    });
  }
};
