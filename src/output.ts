import type { Result } from "@opencode/plugin/promise/tool";
import type { JsonSchema } from "effect";
import { normalizeOutputFormats, OUTPUT_FORMAT, type OutputFormat } from "./config";

/** Model-visible target content; text mode returns it unchanged. */
export type OutputContent = NonNullable<Result["content"]>;

export interface FormatHandler {
  /** Human-readable name used in model-facing format descriptions. */
  readonly label: string;
  /** True when results include the structured output object. */
  readonly providesOutput: boolean;
  /** Short phrase for model-facing descriptions, e.g. "structured output". */
  readonly hint: string;
  /** Output schema contribution; text contributes none. */
  readonly schema: (schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema | undefined;
  readonly respond: (content: OutputContent, output: unknown) => Result["content"];
}

const TEXT_HANDLER: FormatHandler = {
  label: "Text",
  providesOutput: false,
  hint: "text content",
  schema: () => undefined,
  respond: (content) => content,
};

const JSON_HANDLER: FormatHandler = {
  label: "JSON",
  providesOutput: true,
  hint: "structured output",
  schema: (schema) => schema,
  respond: (_content, output) => JSON.stringify(output, null, 2),
};

/** Every format must have a handler; a new OutputFormat fails to compile until added. */
export const FORMAT_HANDLERS = {
  [OUTPUT_FORMAT.text]: TEXT_HANDLER,
  [OUTPUT_FORMAT.json]: JSON_HANDLER,
} as const satisfies Record<OutputFormat, FormatHandler>;

const FORMAT_HANDLER_MAP: ReadonlyMap<OutputFormat, FormatHandler> = new Map(
  Object.entries(FORMAT_HANDLERS) as Array<[OutputFormat, FormatHandler]>,
);

const handlerFor = (format: OutputFormat): FormatHandler => {
  const handler = FORMAT_HANDLER_MAP.get(format);
  if (!handler) throw new Error(`Unsupported output format: ${format}`);
  return handler;
};

export interface OutputStrategy {
  readonly formats: readonly OutputFormat[];
  readonly defaultFormat: OutputFormat;
  readonly includeOutput: boolean;
  readonly formatProperty: () => Record<string, unknown>;
  readonly schema: (schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema | undefined;
  readonly selectFormat: (requested: unknown) => OutputFormat;
  readonly respond: (
    content: OutputContent,
    output: unknown,
    format: OutputFormat,
  ) => Result["content"];
}

interface OutputFormatChoice {
  readonly format: OutputFormat;
  readonly handler: FormatHandler;
}

const structuredFormat = (
  formats: readonly OutputFormat[],
): OutputFormatChoice | undefined => {
  for (const format of formats) {
    const handler = FORMAT_HANDLERS[format];
    if (handler.providesOutput) return { format, handler };
  }
  return undefined;
};

export const describeOutputFormats = (strategy: OutputStrategy): string => {
  if (strategy.formats.length === 1) {
    const handler = FORMAT_HANDLERS[strategy.defaultFormat];
    return `${handler.label} output is forced; the format input is not accepted.`;
  }
  const structured = structuredFormat(strategy.formats);
  if (structured) {
    return `Set format:${structured.format} to return the target's ${structured.handler.hint} as content.`;
  }
  return `Set format:${strategy.formats.join("|")} to choose the response format.`;
};

export const resolveOutputStrategy = (
  allowed: readonly OutputFormat[],
  preferred: OutputFormat = OUTPUT_FORMAT.text,
): OutputStrategy => {
  const formats = normalizeOutputFormats(allowed);
  const handlers = formats.map(handlerFor);
  const handlerByFormat = new Map(
    formats.map((format, index) => [format, handlers[index]] as const),
  );
  const defaultFormat = formats.includes(preferred) ? preferred : formats[0];
  const structured = structuredFormat(formats);
  const formatDescription = structured
    ? `Response format. Defaults to ${defaultFormat}; use ${structured.format} for ${structured.handler.hint}.`
    : `Response format. Defaults to ${defaultFormat}; choose ${formats.join("|")}.`;

  return {
    formats,
    defaultFormat,
    includeOutput: handlers.some((handler) => handler.providesOutput),
    formatProperty: () =>
      formats.length === 1
        ? {}
        : {
            format: {
              type: "string",
              enum: [...formats],
              description: formatDescription,
            },
          },
    schema: (schema) => {
      const contributions = handlers
        .map((handler) => handler.schema(schema))
        .filter((value): value is JsonSchema.JsonSchema => value !== undefined);
      if (contributions.length === 0) return undefined;
      if (contributions.length === 1) return contributions[0];
      return { anyOf: contributions };
    },
    selectFormat: (requested) =>
      typeof requested === "string" && handlerByFormat.has(requested as OutputFormat)
        ? (requested as OutputFormat)
        : defaultFormat,
    respond: (content, output, format) => {
      const handler = handlerByFormat.get(format);
      if (!handler) throw new Error(`Unsupported output format: ${format}`);
      return handler.respond(content, output);
    },
  };
};
