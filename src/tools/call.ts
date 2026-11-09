import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { TEMPLATE_TYPE_LIST } from "../chain";
import { dispatchCall, type DispatchDeps } from "../dispatch";
import { describeOutputFormats, resolveOutputStrategy } from "../output";
import { TOOL } from "./names";

const CALL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string" },
    output: {},
    args: {},
  },
  required: ["tool"],
  additionalProperties: false,
} as const;

export const registerCallTool = (editor: ToolEditor, deps: DispatchDeps) => {
  const outputStrategy = resolveOutputStrategy(deps.config.allowedOutputFormats);
  const formatDescription = describeOutputFormats(outputStrategy);

  editor.add({
    name: TOOL.call,
    options: { namespace: deps.config.namespace, codemode: true },
    description: [
      "Render Handlebars templates into another tool's arguments and call that tool in one step.",
      "Use it when a prompt or argument is large, reusable, or stored in a file, so the model does not repeat it.",
      "Target tools are addressed by exact name, e.g. subagent or subagent_steer.",
      'Plain strings are literal. Wrap templates in {"$inline":"..."} or {"$file":"path"}; use {"$parts":[...]} for a flat chain.',
      'Example: {"tool":"subagent","params":{"task":"auth"},"args":{"agent":"general","description":"Task","prompt":{"$inline":"Do {{task}}"}}}.',
      '"params" shares values across args; "$params" on a template or part overrides them.',
      `"$type" converts a rendered string to ${TEMPLATE_TYPE_LIST}.`,
      "Set renderOnly:true to preview the rendered arguments without calling the target.",
      formatDescription,
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          minLength: 1,
          description: "Exact target tool name, e.g. subagent or subagent_steer.",
        },
        args: {
          anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
          description:
            "Target arguments. Pass an object; a JSON object string is accepted as a fallback. Plain strings are literal; use $inline/$file/$parts for templates.",
        },
        params: {
          type: "object",
          additionalProperties: true,
          description:
            "Values shared by every template object in args. Template and part $params override them.",
        },
        renderOnly: {
          type: "boolean",
          description: "Render args and return them without calling the target.",
        },
        ...outputStrategy.formatProperty(),
      },
      required: ["tool", "args"],
      additionalProperties: false,
    },
    output: outputStrategy.schema(CALL_OUTPUT_SCHEMA),
    execute: async (rawInput, context) => {
      const format = outputStrategy.selectFormat(
        (rawInput as { format?: unknown } | undefined)?.format,
      );
      return dispatchCall(rawInput, context, deps, {
        strategy: outputStrategy,
        format,
      });
    },
  });
};
