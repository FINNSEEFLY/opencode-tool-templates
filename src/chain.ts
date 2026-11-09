import type { ToolContext } from "@opencode/plugin/promise/tool";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { assertByteLimit, byteLength } from "./bytes";
import type { Config } from "./config";
import { abortError, errorMessage, toolError } from "./errors";
import type { PermissionGuard } from "./permissions";
import type { TemplatePaths } from "./paths";
import { createNullRecord, isRecord } from "./record";
import { renderTemplate } from "./render";

interface TypeConverter {
  (value: string, label: string): unknown;
}

/** One converter per template type; the type union and type lists derive from it. */
export const TYPE_CONVERTERS = {
  string: (value) => value,
  number: (value, label) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      return toolError(`Template ${label} rendered empty text, which is not a number.`);
    }
    const number = Number(trimmed);
    if (!Number.isFinite(number)) {
      return toolError(`Template ${label} rendered "${value}", which is not a number.`);
    }
    return number;
  },
  boolean: (value, label) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return toolError(`Template ${label} rendered "${value}", which is not a boolean.`);
  },
  json: (value, label) => {
    try {
      return JSON.parse(value);
    } catch (error) {
      return toolError(`Template ${label} rendered invalid JSON: ${errorMessage(error)}`);
    }
  },
} satisfies Record<string, TypeConverter>;

export type TemplateType = keyof typeof TYPE_CONVERTERS;

export const TEMPLATE_TYPES = Object.keys(TYPE_CONVERTERS) as readonly TemplateType[];

const formatList = (values: readonly string[], quoted: boolean): string => {
  const rendered = quoted ? values.map((value) => `"${value}"`) : [...values];
  if (rendered.length <= 1) return rendered.join("");
  return `${rendered.slice(0, -1).join(", ")}, or ${rendered.at(-1)}`;
};

export const TEMPLATE_TYPE_LIST = formatList(TEMPLATE_TYPES, false);

const QUOTED_TEMPLATE_TYPE_LIST = formatList(TEMPLATE_TYPES, true);

const isTemplateType = (value: unknown): value is TemplateType =>
  typeof value === "string" && (TEMPLATE_TYPES as readonly string[]).includes(value);

// Fixed caps bound recursion and array fan-out; they are not public options.
const MAX_VALUE_DEPTH = 64;
const MAX_ARRAY_ITEMS = 10_000;

interface InlineSource {
  kind: "inline";
  source: string;
}

interface FileSource {
  kind: "file";
  path: string;
}

interface PartsSource {
  kind: "parts";
  parts: TemplatePart[];
}

type TemplateSource = InlineSource | FileSource | PartsSource;

interface TemplatePart {
  source: InlineSource | FileSource;
  params: Record<string, unknown>;
}

interface TemplateRef {
  source: TemplateSource;
  params: Record<string, unknown>;
  type: TemplateType;
  typeExplicit: boolean;
  separator?: string;
  skipEmpty?: boolean;
}

export interface RenderBudget {
  bytes: number;
}

export interface RenderContext {
  tool: ToolContext;
  guard: PermissionGuard;
  budget: RenderBudget;
}

export interface RenderedTemplate {
  text: string;
  parts: number;
  params: Record<string, unknown>;
}

export interface ChainRenderer {
  /** Test seam; production enters through renderArgs or renderTemplateValue. */
  renderValue(
    value: unknown,
    params: Record<string, unknown>,
    context: RenderContext,
  ): Promise<unknown>;
  renderArgs(
    rawArgs: unknown,
    context: RenderContext,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  renderTemplateValue(value: unknown, context: RenderContext): Promise<RenderedTemplate>;
}

const SOURCE_KEYS = ["$inline", "$file", "$parts"] as const;

type SourceKey = (typeof SOURCE_KEYS)[number];

const SOURCE_LIST = formatList(SOURCE_KEYS, false);

const MODIFIER_KEYS = ["$params", "$type", "$separator", "$skipEmpty"] as const;

const GENERIC_MODIFIER_KEYS = MODIFIER_KEYS.filter((key) => key !== "$params");

const TOP_LEVEL_PARAMS_HINT =
  '$params must be inside a template object, for example {"$inline":"...","$params":{...}}.';

const ARGS_PARAMS_HINT =
  `${TOP_LEVEL_PARAMS_HINT} To share values across args, use the params input. ` +
  'Use $type:"json" to pass reserved keys as target arguments.';

const REF_KEYS: ReadonlySet<string> = new Set([...SOURCE_KEYS, ...MODIFIER_KEYS]);

const PART_KEYS = new Set(["$inline", "$file", "$params"]);

const assertNever = (value: never): never => {
  const kind = (value as { kind?: unknown } | undefined)?.kind ?? value;
  throw new Error(`Unhandled template source kind: ${String(kind)}`);
};

const mergeParams = (
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> => {
  const result = createNullRecord();
  for (const [key, value] of Object.entries(parent)) result[key] = value;
  for (const [key, value] of Object.entries(child)) result[key] = value;
  return result;
};

const readParams = (value: unknown, field: string): Record<string, unknown> => {
  if (value === undefined) return createNullRecord();
  if (!isRecord(value)) return toolError(`${field} must be an object.`);
  return mergeParams(createNullRecord(), value);
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string") return toolError(`${field} must be a string.`);
  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") return toolError(`${field} must be a boolean.`);
  return value;
};

const getInlineOrFileSource = (
  value: Record<string, unknown>,
  sourceKey: "$inline" | "$file",
  fieldPrefix: string,
): InlineSource | FileSource => {
  switch (sourceKey) {
    case "$inline":
      return {
        kind: "inline",
        source: requireString(value.$inline, `${fieldPrefix}$inline`),
      };
    case "$file":
      return {
        kind: "file",
        path: requireString(value.$file, `${fieldPrefix}$file`),
      };
    default:
      return assertNever(sourceKey);
  }
};

const parsePart = (value: unknown, index: number): TemplatePart => {
  if (!isRecord(value)) {
    return toolError(`$parts[${index}] must be an object with $inline or $file.`);
  }
  if (Object.hasOwn(value, "$parts")) {
    return toolError(`$parts[${index}] cannot contain nested $parts.`);
  }
  for (const key of Object.keys(value)) {
    if (!PART_KEYS.has(key)) {
      return toolError(`$parts[${index}] has unsupported key "${key}".`);
    }
  }
  const hasInline = Object.hasOwn(value, "$inline");
  const hasFile = Object.hasOwn(value, "$file");
  if (hasInline === hasFile) {
    return toolError(`$parts[${index}] must have exactly one of $inline or $file.`);
  }
  const source = getInlineOrFileSource(
    value,
    hasInline ? "$inline" : "$file",
    `$parts[${index}].`,
  );
  return {
    source,
    params: readParams(
      Object.hasOwn(value, "$params") ? value.$params : undefined,
      `$parts[${index}].$params`,
    ),
  };
};

const parseParts = (value: unknown, maxParts: number): TemplatePart[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return toolError("$parts must be a non-empty array.");
  }
  if (value.length > maxParts) {
    return toolError(`$parts has ${value.length} parts; maxChainParts is ${maxParts}.`);
  }
  const parts: TemplatePart[] = [];
  for (let index = 0; index < value.length; index++) {
    parts.push(parsePart(value[index], index));
  }
  return parts;
};

const getTemplateSource = (
  value: Record<string, unknown>,
  sourceKey: SourceKey,
  maxParts: number,
): TemplateSource => {
  switch (sourceKey) {
    case "$inline":
    case "$file":
      return getInlineOrFileSource(value, sourceKey, "");
    case "$parts":
      return { kind: "parts", parts: parseParts(value.$parts, maxParts) };
    default:
      return assertNever(sourceKey);
  }
};

const parseTemplateRef = (value: unknown, maxParts: number): TemplateRef | undefined => {
  if (!isRecord(value)) return undefined;
  const sourceKeys = SOURCE_KEYS.filter((key) => Object.hasOwn(value, key));
  if (sourceKeys.length === 0) {
    // A top-level `$params` is a common mistake; point at the correct placement.
    if (Object.hasOwn(value, "$params")) return toolError(TOP_LEVEL_PARAMS_HINT);
    if (MODIFIER_KEYS.some((key) => Object.hasOwn(value, key))) {
      return toolError(
        `Template modifiers (${GENERIC_MODIFIER_KEYS.join(", ")}) require a source.`,
      );
    }
    return undefined;
  }
  if (sourceKeys.length > 1) {
    return toolError(`Use exactly one of ${SOURCE_LIST}.`);
  }
  for (const key of Object.keys(value)) {
    if (!REF_KEYS.has(key)) {
      return toolError(`Template object has unsupported key "${key}".`);
    }
  }

  const source = getTemplateSource(value, sourceKeys[0], maxParts);

  if (source.kind !== "parts") {
    if (Object.hasOwn(value, "$separator") || Object.hasOwn(value, "$skipEmpty")) {
      return toolError("$separator and $skipEmpty are only valid on a $parts chain.");
    }
  }

  const type = Object.hasOwn(value, "$type") ? value.$type : "string";
  if (!isTemplateType(type)) {
    return toolError(`$type must be ${QUOTED_TEMPLATE_TYPE_LIST}.`);
  }

  const separator =
    source.kind === "parts" && Object.hasOwn(value, "$separator")
      ? requireString(value.$separator, "$separator")
      : undefined;

  const skipEmpty =
    source.kind === "parts" && Object.hasOwn(value, "$skipEmpty")
      ? requireBoolean(value.$skipEmpty, "$skipEmpty")
      : undefined;

  return {
    source,
    params: readParams(
      Object.hasOwn(value, "$params") ? value.$params : undefined,
      "$params",
    ),
    type,
    typeExplicit: Object.hasOwn(value, "$type"),
    separator,
    skipEmpty,
  };
};

const applyType = (value: string, type: TemplateType, label: string): unknown =>
  TYPE_CONVERTERS[type](value, label);

const sourceName = (source: TemplateSource): string => {
  switch (source.kind) {
    case "inline":
      return "<inline>";
    case "file":
      return source.path;
    case "parts":
      return "<parts>";
    default:
      return assertNever(source);
  }
};

const sourceLabel = (source: TemplateSource): string =>
  JSON.stringify(sourceName(source));

const sourcePartCount = (source: TemplateSource): number => {
  switch (source.kind) {
    case "inline":
    case "file":
      return 1;
    case "parts":
      return source.parts.length;
    default:
      return assertNever(source);
  }
};

const wrapPartError = (error: unknown, index: number, label: string): never => {
  const message = `Chain part ${index + 1} (${label}) failed: ${errorMessage(error)}`;
  if (error instanceof ToolError) {
    throw new ToolError({ message, error, metadata: error.metadata });
  }
  throw new ToolError({ message, error });
};

interface RenderSourceOptions {
  separator?: string;
  skipEmpty?: boolean;
  account?: boolean;
  /** Chain parts add the failure prefix once, at the part boundary. */
  wrapTemplateErrors?: boolean;
  /** Filled with the rendered path after a file path template succeeds. */
  resolvedPath?: { value?: string };
}

const parseJsonObject = (value: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return toolError(`args is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) return toolError("args must be a JSON object.");
  return parsed;
};

const serializeParams = (params: Record<string, unknown>): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(params);
  } catch (error) {
    return toolError(`$params must be JSON-serializable: ${errorMessage(error)}`);
  }
  if (serialized === undefined) {
    return toolError(
      "$params must be JSON-serializable: JSON.stringify returned undefined.",
    );
  }
  return serialized;
};

const assertParamsBytes = (params: Record<string, unknown>, maxBytes: number): void => {
  const serialized = serializeParams(params);
  assertByteLimit({
    bytes: byteLength(serialized),
    max: maxBytes,
    label: "$params",
  });
};

const maxDepthError = (): never =>
  toolError(
    `Template args exceed the maximum depth of ${MAX_VALUE_DEPTH} nested objects or arrays.`,
  );

const maxArrayItemsError = (length: number): never =>
  toolError(
    `Template args contain ${length} array items; the maximum is ${MAX_ARRAY_ITEMS}.`,
  );

interface PendingValue {
  value: unknown;
  depth: number;
}

/**
 * Check parsed JSON iteratively. A recursive check would overflow on the same
 * deep values it is meant to reject.
 */
const assertValueBounds = (value: unknown): void => {
  const pending: PendingValue[] = [{ value, depth: 0 }];
  let current = pending.pop();
  while (current !== undefined) {
    if (Array.isArray(current.value)) {
      if (current.depth >= MAX_VALUE_DEPTH) maxDepthError();
      if (current.value.length > MAX_ARRAY_ITEMS) {
        maxArrayItemsError(current.value.length);
      }
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      if (current.depth >= MAX_VALUE_DEPTH) maxDepthError();
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
    current = pending.pop();
  }
};

export const createChainRenderer = ({
  config,
  paths,
}: {
  config: Config;
  paths: TemplatePaths;
}): ChainRenderer => {
  const assertRenderedBytes = (bytes: number): void => {
    assertByteLimit({
      bytes,
      max: config.limits.maxRenderedBytes,
      label: "Rendered templates",
      verb: "are",
    });
  };

  const account = (text: string, context: RenderContext) => {
    context.budget.bytes += byteLength(text);
    assertRenderedBytes(context.budget.bytes);
  };

  const renderSource = async (
    source: TemplateSource,
    params: Record<string, unknown>,
    context: RenderContext,
    options: RenderSourceOptions = {},
  ): Promise<string> => {
    const accountText = options.account !== false;
    const wrapErrors = options.wrapTemplateErrors !== false;
    if (source.kind === "inline") {
      const sourceBytes = byteLength(source.source);
      assertByteLimit({
        bytes: sourceBytes,
        max: config.limits.maxTemplateBytes,
        label: "Inline template",
        limit: "maxTemplateBytes",
      });
    }
    assertParamsBytes(params, config.limits.maxRenderedBytes);
    switch (source.kind) {
      case "inline": {
        const text = renderTemplate(source.source, params, '"<inline>"', {
          wrapErrors,
        });
        if (accountText) account(text, context);
        return text;
      }
      case "file": {
        const path = renderTemplate(source.path, params, '"<file path>"', {
          wrapErrors,
        });
        if (options.resolvedPath) options.resolvedPath.value = path;
        const file = await paths.readTemplate(path, context.tool, context.guard);
        const text = renderTemplate(file.text, params, JSON.stringify(file.resource), {
          wrapErrors,
        });
        if (accountText) account(text, context);
        return text;
      }
      case "parts": {
        const separator = options.separator ?? config.defaultSeparator;
        const skipEmpty = options.skipEmpty ?? config.defaultSkipEmpty;
        const rendered: string[] = [];
        let bytes = 0;
        for (let index = 0; index < source.parts.length; index++) {
          const part = source.parts[index];
          const partParams = mergeParams(params, part.params);
          const resolvedPath: { value?: string } = {};
          try {
            const text = await renderSource(part.source, partParams, context, {
              account: false,
              wrapTemplateErrors: false,
              resolvedPath,
            });
            // "Empty" means zero characters; whitespace-only parts are kept.
            if (skipEmpty && text === "") continue;
            bytes += byteLength(text);
            if (rendered.length > 0) bytes += byteLength(separator);
            assertRenderedBytes(bytes);
            rendered.push(text);
          } catch (error) {
            if (context.tool.signal?.aborted) throw abortError(context.tool.signal);
            return wrapPartError(
              error,
              index,
              resolvedPath.value ?? sourceName(part.source),
            );
          }
        }
        const text = rendered.join(separator);
        if (accountText) account(text, context);
        return text;
      }
      default:
        return assertNever(source);
    }
  };

  const renderRefSource = (
    ref: TemplateRef,
    params: Record<string, unknown>,
    context: RenderContext,
  ): Promise<string> =>
    renderSource(ref.source, params, context, {
      separator: ref.separator,
      skipEmpty: ref.skipEmpty,
    });

  const renderRef = async (
    ref: TemplateRef,
    parentParams: Record<string, unknown>,
    context: RenderContext,
  ): Promise<unknown> => {
    const params = mergeParams(parentParams, ref.params);
    const text = await renderRefSource(ref, params, context);
    const result = applyType(text, ref.type, sourceLabel(ref.source));
    assertValueBounds(result);
    return result;
  };

  const renderValue = async (
    value: unknown,
    params: Record<string, unknown>,
    context: RenderContext,
    depth = 0,
  ): Promise<unknown> => {
    const ref = parseTemplateRef(value, config.limits.maxChainParts);
    if (ref) return renderRef(ref, params, context);
    if (Array.isArray(value)) {
      if (depth >= MAX_VALUE_DEPTH) return maxDepthError();
      if (value.length > MAX_ARRAY_ITEMS) return maxArrayItemsError(value.length);
      return Promise.all(
        value.map((item) => renderValue(item, params, context, depth + 1)),
      );
    }
    if (isRecord(value)) {
      if (depth >= MAX_VALUE_DEPTH) return maxDepthError();
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(result, key, {
          value: await renderValue(item, params, context, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    return value;
  };

  const renderArgsObject = async (
    value: Record<string, unknown>,
    params: Record<string, unknown>,
    context: RenderContext,
  ): Promise<Record<string, unknown>> => {
    // Only the top-level `args` object gets the target-specific guidance;
    // template_build and nested values use the context-neutral hint.
    const hasSource = SOURCE_KEYS.some((key) => Object.hasOwn(value, key));
    if (!hasSource && Object.hasOwn(value, "$params")) {
      return toolError(ARGS_PARAMS_HINT);
    }
    const ref = parseTemplateRef(value, config.limits.maxChainParts);
    if (ref) {
      const effectiveRef = ref.typeExplicit ? ref : { ...ref, type: "json" as const };
      const rendered = await renderRef(effectiveRef, params, context);
      if (!isRecord(rendered)) return toolError("args must render to a JSON object.");
      return rendered;
    }
    const rendered = await renderValue(value, params, context);
    if (!isRecord(rendered)) return toolError("args must be an object.");
    return rendered;
  };

  const renderArgs = async (
    rawArgs: unknown,
    context: RenderContext,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const sharedParams = readParams(params, "params");
    if (typeof rawArgs === "string") {
      const bytes = byteLength(rawArgs);
      assertByteLimit({
        bytes,
        max: config.limits.maxRenderedBytes,
        label: "args",
      });
      return renderArgsObject(parseJsonObject(rawArgs), sharedParams, context);
    }
    if (isRecord(rawArgs)) return renderArgsObject(rawArgs, sharedParams, context);
    return toolError("args must be an object or a JSON object string.");
  };

  const renderTemplateValue = async (
    value: unknown,
    context: RenderContext,
  ): Promise<RenderedTemplate> => {
    const ref = parseTemplateRef(value, config.limits.maxChainParts);
    if (!ref) {
      return toolError(
        'template must be a template object: { "$inline": ... }, { "$file": ... }, or { "$parts": [...] }.',
      );
    }
    if (ref.typeExplicit && ref.type !== "string") {
      return toolError('Only $type: "string" is supported on template_build.');
    }
    const text = await renderRefSource(ref, ref.params, context);
    return {
      text,
      parts: sourcePartCount(ref.source),
      params: ref.params,
    };
  };

  return { renderValue, renderArgs, renderTemplateValue };
};
