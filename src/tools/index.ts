import type { ToolEditor } from "@opencode/plugin/promise/tool";
import type { BuildDeps } from "../build";
import type { DispatchDeps } from "../dispatch";
import { registerBuildTool } from "./build";
import { registerCallTool } from "./call";

export interface ToolDeps extends DispatchDeps, BuildDeps {}

export const registerTools = (editor: ToolEditor, deps: ToolDeps) => {
  editor.namespace({
    name: deps.config.namespace,
    description:
      "Render Handlebars templates into tool arguments, call tools, and build template files.",
  });
  registerCallTool(editor, deps);
  registerBuildTool(editor, deps);
};
