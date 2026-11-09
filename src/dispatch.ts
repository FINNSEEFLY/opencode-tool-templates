import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { assertByteLimit, byteLength } from "./bytes";
import type { ChainRenderer, RenderContext } from "./chain";
import { isDeniedTool, type Config, type OutputFormat } from "./config";
import {
  abortError,
  errorMessage,
  REQUIRED_ARGS,
  REQUIRED_TOOL,
  toolError,
} from "./errors";
import type { OutputStrategy } from "./output";
import { createPermissionGuard, type PermissionApi } from "./permissions";
import { isPlainRecord, isRecord } from "./record";
import { isEffectiveToolName } from "./tool-name";
import { validateTargetInput } from "./validation";

export type TargetTool = Info & { readonly id: string };

export interface DispatchDeps {
  config: Config;
  renderer: ChainRenderer;
  permission: PermissionApi;
  toolList: () => Promise<readonly TargetTool[]>;
  selfToolName: string;
}

interface CallInput {
  tool: string;
  args: unknown;
  params?: Record<string, unknown>;
  renderOnly: boolean;
}

export interface DispatchOptions {
  strategy: OutputStrategy;
  format: OutputFormat;
}

const requireToolName = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return toolError(REQUIRED_TOOL);
  }
  const name = value.trim();
  if (!isEffectiveToolName(name)) {
    return toolError(
      "tool must name the target exactly, e.g. subagent or subagent_steer.",
    );
  }
  return name;
};

const readCallInput = (rawInput: unknown): CallInput => {
  if (!isRecord(rawInput)) return toolError("template_call input must be an object.");
  const tool = requireToolName(
    Object.hasOwn(rawInput, "tool") ? rawInput.tool : undefined,
  );
  if (!Object.hasOwn(rawInput, "args")) return toolError(REQUIRED_ARGS);
  const params = Object.hasOwn(rawInput, "params") ? rawInput.params : undefined;
  if (params !== undefined && !isRecord(params)) {
    return toolError("params must be an object.");
  }
  const renderOnly = Object.hasOwn(rawInput, "renderOnly")
    ? rawInput.renderOnly
    : undefined;
  if (renderOnly !== undefined && typeof renderOnly !== "boolean") {
    return toolError("renderOnly must be a boolean.");
  }
  return {
    tool,
    args: rawInput.args,
    params,
    renderOnly: renderOnly === true,
  };
};

interface TargetContext {
  config: Config;
  selfToolName: string;
  name: string;
}

/** Ordered rules; the first rejection decides the error and the inventory filter. */
const TARGET_RULES: readonly {
  readonly rejection: (name: string) => string;
  readonly allows: (context: TargetContext) => boolean;
}[] = [
  {
    rejection: () => "template_call cannot call itself.",
    allows: ({ selfToolName, name }) => name !== selfToolName,
  },
  {
    rejection: (name) => `Tool "${name}" is not in allowedTools.`,
    allows: ({ config, name }) =>
      config.allowedTools.length === 0 || config.allowedTools.includes(name),
  },
  {
    rejection: (name) => `Tool "${name}" is denied by deniedTools.`,
    allows: ({ config, name }) => !isDeniedTool(config, name),
  },
];

const isTargetAllowed = (context: TargetContext): boolean =>
  TARGET_RULES.every((rule) => rule.allows(context));

const assertTargetAllowed = (config: Config, selfToolName: string, name: string) => {
  const context = { config, selfToolName, name };
  const rejection = TARGET_RULES.find((rule) => !rule.allows(context))?.rejection(name);
  if (rejection) return toolError(rejection);
};

const MAX_VISIBLE_TARGETS = 50;

const findTarget = async (deps: DispatchDeps, name: string): Promise<TargetTool> => {
  const tools = await deps.toolList();
  const target = tools.find((tool) => tool.id === name);
  if (target) return target;
  if (deps.config.allowedTools.length === 0) {
    return toolError(`Unknown tool "${name}".`);
  }
  const context = { config: deps.config, selfToolName: deps.selfToolName };
  const candidates = tools
    .map((tool) => tool.id)
    .filter((id) => isTargetAllowed({ ...context, name: id }))
    .toSorted();
  const visible = candidates.slice(0, MAX_VISIBLE_TARGETS);
  const suffix = candidates.length > visible.length ? ", ..." : "";
  const available =
    visible.length === 0 ? "" : ` Available tools: ${visible.join(", ")}${suffix}.`;
  return toolError(`Unknown tool "${name}".${available}`);
};

const invalidResult = (tool: string): never =>
  toolError(`Target tool "${tool}" returned an invalid result.`);

const invalidContent = (tool: string): never =>
  toolError(
    `Target tool "${tool}" returned invalid content; expected a string or content array.`,
  );

const invalidOutput = (tool: string): never =>
  toolError(
    `Target tool "${tool}" returned invalid output; expected a JSON-serializable value.`,
  );

const serializeOutput = (output: unknown, tool: string): string => {
  try {
    const serialized = JSON.stringify(output);
    if (serialized === undefined) return invalidOutput(tool);
    return serialized;
  } catch {
    return invalidOutput(tool);
  }
};

const serializeRenderedArgs = (
  renderedArgs: Record<string, unknown>,
  tool: string,
  space?: number,
): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(renderedArgs, null, space);
  } catch (error) {
    return toolError(
      `Rendered args for tool "${tool}" are not JSON-serializable: ${errorMessage(error)}`,
    );
  }
  if (serialized === undefined) {
    return toolError(
      `Rendered args for tool "${tool}" are not JSON-serializable: JSON.stringify returned undefined.`,
    );
  }
  return serialized;
};

const normalizeContent = (
  content: unknown,
  tool: string,
  serializedOutput: string | undefined,
): NonNullable<Result["content"]> => {
  if (typeof content === "string" || Array.isArray(content)) return content;
  if (content !== undefined && content !== null) return invalidContent(tool);
  if (serializedOutput !== undefined) return serializedOutput;
  return "";
};

const assertSupportedFormat = (options: DispatchOptions): void => {
  if (!options.strategy.formats.includes(options.format)) {
    toolError(`Unsupported output format: ${options.format}`);
  }
};

export const dispatchCall = async (
  rawInput: unknown,
  context: ToolContext,
  deps: DispatchDeps,
  options: DispatchOptions,
) => {
  if (context.signal?.aborted) throw abortError(context.signal);
  assertSupportedFormat(options);
  const input = readCallInput(rawInput);
  assertTargetAllowed(deps.config, deps.selfToolName, input.tool);
  const target = await findTarget(deps, input.tool);
  const guard = createPermissionGuard(deps.permission);
  const renderContext: RenderContext = { tool: context, guard, budget: { bytes: 0 } };
  const renderedArgs = await deps.renderer.renderArgs(
    input.args,
    renderContext,
    input.params,
  );

  const serialized = serializeRenderedArgs(renderedArgs, input.tool);
  const bytes = byteLength(serialized);
  assertByteLimit({
    bytes,
    max: deps.config.limits.maxRenderedBytes,
    label: "Rendered args",
    verb: "are",
  });

  if (input.renderOnly) {
    const content = serializeRenderedArgs(renderedArgs, input.tool, 2);
    const contentBytes = byteLength(content);
    assertByteLimit({
      bytes: contentBytes,
      max: deps.config.limits.maxRenderedBytes,
      label: "renderOnly content",
    });
    if (context.signal?.aborted) throw abortError(context.signal);
    const argsOutput = { tool: input.tool, args: renderedArgs };
    return {
      content,
      ...(options.strategy.includeOutput ? { output: argsOutput } : {}),
      metadata: { templateTarget: input.tool },
    };
  }

  let decodedArgs: unknown;
  try {
    decodedArgs = await validateTargetInput(target.input, renderedArgs);
  } catch (error) {
    const hint =
      "If a field expects a number, boolean, or JSON value, render it with $type.";
    throw new ToolError({
      message: `Invalid arguments for target tool "${input.tool}": ${errorMessage(error)}. ${hint}`,
      error,
    });
  }

  if (context.signal?.aborted) throw abortError(context.signal);

  let result: unknown;
  try {
    result = await target.execute(decodedArgs, context);
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (error instanceof ToolError) {
      throw new ToolError({
        message: `Target tool "${input.tool}" failed: ${error.message}`,
        error,
        metadata: error.metadata,
      });
    }
    throw new ToolError({
      message: `Target tool "${input.tool}" failed: ${errorMessage(error)}`,
      error,
    });
  }

  if (!isRecord(result)) return invalidResult(input.tool);

  // Tool.Result has no error flag. Content returned by the target is target
  // output, even when it looks like an error; only thrown failures get a prefix.
  const targetContent = result.content;
  const hasContent = typeof targetContent === "string" || Array.isArray(targetContent);
  if (!hasContent && targetContent !== undefined && targetContent !== null) {
    return invalidContent(input.tool);
  }

  const serializedOutput =
    result.output === undefined || (hasContent && !options.strategy.includeOutput)
      ? undefined
      : serializeOutput(result.output, input.tool);
  const outputObject =
    result.output === undefined
      ? { tool: input.tool }
      : { tool: input.tool, output: result.output };
  let content: Result["content"];
  try {
    content = options.strategy.respond(
      normalizeContent(targetContent, input.tool, serializedOutput),
      outputObject,
      options.format,
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return invalidOutput(input.tool);
  }

  return {
    content,
    ...(options.strategy.includeOutput ? { output: outputObject } : {}),
    metadata: isPlainRecord(result.metadata)
      ? { ...result.metadata, templateTarget: input.tool }
      : { templateTarget: input.tool },
  };
};
