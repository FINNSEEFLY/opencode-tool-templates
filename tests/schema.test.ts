import { describe, expect, it } from "bun:test";
import { TEMPLATE_TYPE_LIST } from "../src/chain";
import { makeHarness } from "./harness";
import { validateSchema } from "./schema";

const getTool = async (name: string, options: Record<string, any> = {}) => {
  const h = makeHarness({ options });
  await h.setup();
  const tool = [...h.tools.values()].find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} is not registered`);
  return { h, tool };
};

describe("tool schemas", () => {
  it("registers namespaced Code Mode tools", async () => {
    const { h } = await getTool("call");
    const call = [...h.tools.values()].find((entry) => entry.name === "call");
    const build = [...h.tools.values()].find((entry) => entry.name === "build");

    expect(h.namespaces[0].name).toBe("template");
    expect(call?.options).toEqual({ namespace: "template", codemode: true });
    expect(build?.options).toEqual({ namespace: "template", codemode: true });
  });

  it("registers template_call with JSON output and format by default", async () => {
    const { tool } = await getTool("call");

    expect(tool.output).toEqual({
      type: "object",
      properties: {
        tool: { type: "string" },
        output: {},
        args: {},
      },
      required: ["tool"],
      additionalProperties: false,
    });
    expect(tool.input.properties.format).toEqual({
      type: "string",
      enum: ["text", "json"],
      description: "Response format. Defaults to text; use json for structured output.",
    });
    expect(tool.input.required).toEqual(["tool", "args"]);
    expect(tool.input.additionalProperties).toBe(false);
    expect(tool.input.properties.params).toEqual({
      type: "object",
      additionalProperties: true,
      description:
        "Values shared by every template object in args. Template and part $params override them.",
    });
    expect(tool.description).toContain("$inline");
    expect(tool.description).toContain("$file");
    expect(tool.description).toContain("$parts");
    expect(tool.description).toContain("$params");
    expect(tool.description).toContain("$type");
    expect(tool.description).toContain(
      `"$type" converts a rendered string to ${TEMPLATE_TYPE_LIST}.`,
    );
    expect(tool.description).toContain("renderOnly");
    expect(tool.description).toContain("Plain strings are literal");
    expect(tool.description).toContain(
      'Example: {"tool":"subagent","params":{"task":"auth"},"args":{"agent":"general","description":"Task","prompt":{"$inline":"Do {{task}}"}}}',
    );
    expect(tool.description).toContain(
      '"params" shares values across args; "$params" on a template or part overrides them.',
    );
    expect(tool.description).toContain(
      "Set format:json to return the target's structured output as content.",
    );
  });

  it("omits the output schema and format in text-only mode", async () => {
    const { tool } = await getTool("call", { allowedOutputFormats: ["text"] });

    expect(tool.output).toBeUndefined();
    expect(tool.input.properties.format).toBeUndefined();
    expect(tool.description).toContain(
      "Text output is forced; the format input is not accepted.",
    );
  });

  it("omits format in json-only mode", async () => {
    const { tool } = await getTool("call", { allowedOutputFormats: ["json"] });

    expect(tool.output).toBeDefined();
    expect(tool.input.properties.format).toBeUndefined();
    expect(tool.description).toContain(
      "JSON output is forced; the format input is not accepted.",
    );
  });

  it("accepts representative template_call inputs", async () => {
    const { tool } = await getTool("call");

    expect(
      validateSchema({ tool: "subagent", args: { prompt: "hi" } }, tool.input),
    ).toEqual([]);
    expect(
      validateSchema(
        { tool: "subagent", params: { task: "auth" }, args: { prompt: "hi" } },
        tool.input,
      ),
    ).toEqual([]);
    expect(validateSchema({ tool: "subagent", args: "{}" }, tool.input)).toEqual([]);
    expect(
      validateSchema(
        { tool: "subagent", args: { prompt: "hi" }, renderOnly: true },
        tool.input,
      ),
    ).toEqual([]);
    expect(
      validateSchema({ tool: "subagent", args: {}, format: "json" }, tool.input),
    ).toEqual([]);
  });

  it("rejects invalid template_call inputs", async () => {
    const { tool } = await getTool("call");

    expect(validateSchema({ tool: "subagent" }, tool.input)).not.toEqual([]);
    expect(
      validateSchema({ tool: "subagent", args: {}, extra: true }, tool.input),
    ).not.toEqual([]);
    expect(validateSchema({ tool: "", args: {} }, tool.input)).not.toEqual([]);
    expect(validateSchema({ tool: 42, args: {} }, tool.input)).not.toEqual([]);
    expect(validateSchema({ tool: "subagent", args: 42 }, tool.input)).not.toEqual([]);
    expect(
      validateSchema({ tool: "subagent", params: ["x"], args: {} }, tool.input),
    ).not.toEqual([]);
    expect(
      validateSchema({ tool: "subagent", args: {}, renderOnly: "true" }, tool.input),
    ).not.toEqual([]);
    expect(
      validateSchema({ tool: "subagent", args: {}, format: "xml" }, tool.input),
    ).not.toEqual([]);
  });

  it("registers template_build with an object output schema", async () => {
    const { tool } = await getTool("build");

    expect(tool.output).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string" },
        bytes: { type: "integer" },
        parts: { type: "integer" },
      },
      required: ["bytes", "parts"],
      additionalProperties: false,
    });
    expect(tool.input.required).toEqual(["template"]);
    expect(tool.input.properties.template.type).toBe("object");
    expect(tool.input.additionalProperties).toBe(false);
    expect(tool.description).toContain("$params");
    expect(tool.description).toContain('$type: "string"');
    expect(tool.description).toContain("Plain strings are literal");
    expect(tool.description).toContain(
      'Example: {"template":{"$inline":"Hello {{name}}","$params":{"name":"Ada"}}}',
    );
  });

  it("validates template_build inputs", async () => {
    const { tool } = await getTool("build");

    expect(validateSchema({ template: { $inline: "hi" } }, tool.input)).toEqual([]);
    expect(
      validateSchema(
        { template: { $inline: "hi" }, path: "build/a.md", overwrite: true },
        tool.input,
      ),
    ).toEqual([]);
    expect(validateSchema({ template: "hi" }, tool.input)).not.toEqual([]);
    expect(validateSchema({}, tool.input)).not.toEqual([]);
    expect(
      validateSchema({ template: { $inline: "hi" }, path: "" }, tool.input),
    ).not.toEqual([]);
  });

  it("validates representative template_call outputs", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({ content: "ok", output: { sessionID: "ses_child" } }),
    });
    await h.setup();
    const tool = [...h.tools.values()].find((entry) => entry.name === "call")!;

    const text = await h.callTool({ tool: "subagent", args: {} });
    expect(validateSchema(text.output, tool.output)).toEqual([]);

    const json = await h.callTool({ tool: "subagent", args: {}, format: "json" });
    expect(validateSchema(json.output, tool.output)).toEqual([]);

    const preview = await h.callTool({
      tool: "subagent",
      args: { prompt: "hi" },
      renderOnly: true,
    });
    expect(validateSchema(preview.output, tool.output)).toEqual([]);
  });

  it("validates representative template_build outputs", async () => {
    const h = makeHarness();
    await h.setup();
    const tool = [...h.tools.values()].find((entry) => entry.name === "build")!;

    const text = await h.callBuild({ template: { $inline: "hi" } });
    expect(validateSchema(text.output, tool.output)).toEqual([]);

    const file = await h.callBuild({
      template: { $inline: "hi" },
      path: "build/a.md",
    });
    expect(validateSchema(file.output, tool.output)).toEqual([]);
  });

  it("describes the available output formats", async () => {
    const text = await getTool("call", { allowedOutputFormats: ["text"] });
    expect(text.tool.description).not.toContain("format:json");

    const json = await getTool("call", { allowedOutputFormats: ["json"] });
    expect(json.tool.description).toContain("JSON output is forced");

    const build = await getTool("build");
    expect(build.tool.description).toContain('$type: "string"');
  });
});
