import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { runBuild, type BuildDeps } from "../build";
import { TOOL } from "./names";

const BUILD_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    path: { type: "string" },
    bytes: { type: "integer" },
    parts: { type: "integer" },
  },
  required: ["bytes", "parts"],
  additionalProperties: false,
} as const;

export const registerBuildTool = (editor: ToolEditor, deps: BuildDeps) => {
  editor.add({
    name: TOOL.build,
    options: { namespace: deps.config.namespace, codemode: true },
    description: [
      "Assemble a Handlebars template object and return the text or write it to a file.",
      'The template must be a template object: {"$inline":"..."}, {"$file":"path"}, or {"$parts":[...]}.',
      'Plain strings are literal; wrap them in {"$inline":"..."} or {"$file":"path"}.',
      'Example: {"template":{"$inline":"Hello {{name}}","$params":{"name":"Ada"}}}.',
      '"$params" provides values for the object/chain; a part can override them.',
      'Only $type: "string" is supported; the result is always text.',
      "Without path, the assembled text is returned. With path, the text is written and is not returned; the result contains path, bytes, and parts.",
      "path is rendered with the template object's $params and must match buildPaths. overwrite defaults to false.",
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        template: {
          type: "object",
          additionalProperties: true,
          description:
            "Template object: { $inline }, { $file }, or { $parts }. Plain strings are not accepted.",
        },
        path: {
          type: "string",
          minLength: 1,
          description:
            "Optional output path. When present, the assembled text is written to this file and is not returned.",
        },
        overwrite: {
          type: "boolean",
          description: "Allow replacing an existing file. Only valid with path.",
        },
      },
      required: ["template"],
      additionalProperties: false,
    },
    output: BUILD_OUTPUT_SCHEMA,
    execute: async (rawInput, context) => runBuild(rawInput, context, deps),
  });
};
