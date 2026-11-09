import type { ToolContext } from "@opencode/plugin/promise/tool";
import { assertByteLimit, byteLength } from "./bytes";
import type { ChainRenderer, RenderContext } from "./chain";
import type { Config } from "./config";
import { abortError, toolError } from "./errors";
import { createPermissionGuard, type PermissionApi } from "./permissions";
import type { TemplatePaths } from "./paths";
import { isRecord } from "./record";
import { renderTemplate } from "./render";

export interface BuildDeps {
  config: Config;
  renderer: ChainRenderer;
  paths: TemplatePaths;
  permission: PermissionApi;
}

interface BuildInput {
  template: unknown;
  path?: string;
  overwrite: boolean;
}

const readBuildInput = (rawInput: unknown): BuildInput => {
  if (!isRecord(rawInput)) return toolError("template_build input must be an object.");
  if (!Object.hasOwn(rawInput, "template")) {
    return toolError("template is required.");
  }
  const path = Object.hasOwn(rawInput, "path") ? rawInput.path : undefined;
  const overwrite = Object.hasOwn(rawInput, "overwrite") ? rawInput.overwrite : undefined;
  if (path !== undefined && typeof path !== "string") {
    return toolError("path must be a string.");
  }
  if (overwrite !== undefined && typeof overwrite !== "boolean") {
    return toolError("overwrite must be a boolean.");
  }
  if (overwrite !== undefined && path === undefined) {
    return toolError("overwrite is only valid with path.");
  }
  if (typeof path === "string" && path.includes("\0")) {
    return toolError("Output path contains a NUL byte.");
  }
  if (typeof path === "string" && path.trim().length === 0) {
    return toolError("path must be a non-empty string.");
  }
  return {
    template: rawInput.template,
    path,
    overwrite: overwrite === true,
  };
};

export const runBuild = async (
  rawInput: unknown,
  context: ToolContext,
  deps: BuildDeps,
) => {
  if (context.signal?.aborted) throw abortError(context.signal);
  const input = readBuildInput(rawInput);
  const guard = createPermissionGuard(deps.permission);
  const renderContext: RenderContext = {
    tool: context,
    guard,
    budget: { bytes: 0 },
  };
  const rendered = await deps.renderer.renderTemplateValue(input.template, renderContext);
  const bytes = byteLength(rendered.text);
  assertByteLimit({
    bytes,
    max: deps.config.limits.maxRenderedBytes,
    label: "Output",
  });
  if (context.signal?.aborted) throw abortError(context.signal);

  if (input.path === undefined) {
    return {
      content: rendered.text,
      output: {
        text: rendered.text,
        bytes,
        parts: rendered.parts,
      },
    };
  }

  const path = renderTemplate(input.path, rendered.params, '"<output path>"');
  if (path.trim().length === 0) {
    return toolError("Output path is empty after rendering.");
  }
  const pathBytes = byteLength(path);
  assertByteLimit({
    bytes: pathBytes,
    max: deps.config.limits.maxRenderedBytes,
    label: "Output path",
  });
  if (context.signal?.aborted) throw abortError(context.signal);
  const written = await deps.paths.writeTemplate(path, rendered.text, context, guard, {
    overwrite: input.overwrite,
  });
  if (context.signal?.aborted) throw abortError(context.signal);
  const partLabel = rendered.parts === 1 ? "part" : "parts";
  return {
    content: `Wrote ${written.path} (${written.bytes} bytes, ${rendered.parts} ${partLabel}).`,
    output: {
      path: written.path,
      bytes: written.bytes,
      parts: rendered.parts,
    },
  };
};
