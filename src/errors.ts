import { Error as ToolError } from "@opencode/plugin/promise/tool";

export const OPENCODE_REQUIREMENT =
  "opencode-tool-templates requires an OpenCode build with ctx.tool.list and ctx.permission.assert. See the README for the supported version.";

export const REQUIRED_TOOL = "tool is required.";
export const REQUIRED_ARGS = "args is required.";

/**
 * Refusals are tool errors, not successful results. OpenCode surfaces
 * `Tool.Error` to the model with the reason, so the model can correct course
 * instead of treating a refusal as normal output.
 */
export const toolError = (message: string): never => {
  throw new ToolError({ message });
};

export const abortError = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
};

const MAX_THROWN_DESCRIPTION = 200;
const UNSERIALIZABLE_OBJECT = "[unserializable object]";

const bounded = (text: string): string =>
  text.length <= MAX_THROWN_DESCRIPTION
    ? text
    : `${text.slice(0, MAX_THROWN_DESCRIPTION)}...`;

const objectDescription = (value: object): string => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return bounded(serialized);
  } catch {
    // Circular or otherwise unserializable values get a stable description.
  }
  return UNSERIALIZABLE_OBJECT;
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    return objectDescription(error);
  }
  return String(error);
};
