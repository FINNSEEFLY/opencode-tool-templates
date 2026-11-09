import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Schema } from "effect";
import type { ChainRenderer } from "../src/chain";
import { resolveConfig, type OutputFormat } from "../src/config";
import { dispatchCall, type DispatchDeps } from "../src/dispatch";
import { resolveOutputStrategy } from "../src/output";
import { makeToolContext } from "./context";
import { makeHarness } from "./harness";

const captureToolFailure = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("Expected a rejection");
};

const expectToolFailure = async (promise: Promise<unknown>, message: RegExp) => {
  expect((await captureToolFailure(promise)).message).toMatch(message);
};

const rejectUnexpectedDispatch = async (): Promise<never> => {
  throw new Error("dispatch should reject the format first");
};

const matchesPermissionPattern = (pattern: string, value: string): boolean => {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(value.replaceAll("\\", "/"));
};

type PermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny";
};

const usePermissionRules = (
  h: ReturnType<typeof makeHarness>,
  rules: readonly PermissionRule[],
) => {
  h.ctx.permission.assert = async (input: any) => {
    h.permissionCalls.push(input);
    const denied = input.resources.some((resource: string) => {
      const rule = rules.findLast(
        (entry) =>
          matchesPermissionPattern(entry.action, input.action) &&
          matchesPermissionPattern(entry.resource, resource),
      );
      return rule?.effect === "deny";
    });
    if (denied) throw new ToolError({ message: `Permission denied: ${input.action}` });
  };
};

// Draft-07 rejects the extra tuple item via additionalItems: false; the
// 2020-12 converter ignores additionalItems and accepts it.
const draftSensitiveSchema = () => ({
  type: "object",
  properties: {
    values: {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: false,
    },
  },
  required: ["values"],
});

describe("template_call", () => {
  it("renders args and calls the target", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: `ran ${args.agent}`, output: { sessionID: "ses_child" } };
      },
    });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: {
        agent: "general",
        prompt: { $inline: "Task {{TASK_ID}}", $params: { TASK_ID: "T-1" } },
      },
    });

    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({
      agent: "general",
      prompt: "Task T-1",
    });
    expect(result.content).toBe("ran general");
    expect(result.metadata).toEqual({ templateTarget: "subagent" });
  });

  it("normalizes a missing variable in a $file template", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();
    await h.write("prompts/sleep-task.md", "Sleep\nTask {{TASK_ID}}");

    const error = await captureToolFailure(
      h.callTool({
        tool: "subagent",
        args: { prompt: { $file: "prompts/sleep-task.md" } },
      }),
    );

    expect(error.message).toBe(
      'Template "prompts/sleep-task.md" failed: "TASK_ID" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.TASK_ID}} if the name collides with a helper.',
    );
    expect(error.message.match(/failed:/g)).toHaveLength(1);
  });

  it("keeps plain strings literal", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      args: { prompt: "Task {{TASK_ID}}" },
    });

    expect(calls[0].prompt).toBe("Task {{TASK_ID}}");
  });

  it("explains top-level $params placement", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    const error = await captureToolFailure(
      h.callTool({
        tool: "subagent",
        args: { prompt: "hi", $params: { name: "X" } },
      }),
    );

    expect(error.message).toBe(
      '$params must be inside a template object, for example {"$inline":"...","$params":{...}}. ' +
        'To share values across args, use the params input. Use $type:"json" to pass reserved keys as target arguments.',
    );
  });

  it("shares params across args with template and part overrides", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      params: { project: "billing", task: "root" },
      args: {
        description: {
          $inline: "{{project}}/{{task}}",
          $params: { task: "template" },
        },
        prompt: {
          $parts: [
            { $inline: "{{project}}/{{task}}" },
            { $inline: "{{project}}/{{task}}", $params: { task: "part" } },
          ],
          $params: { task: "chain" },
        },
      },
    });

    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({
      description: "billing/template",
      prompt: "billing/chain\n\nbilling/part",
    });
  });

  it("passes params to a whole-args template", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      params: { agent: "general", prompt: "Hello" },
      args: {
        $inline: '{"agent":"{{agent}}","prompt":"{{prompt}}"}',
        $type: "json",
      },
    });

    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({
      agent: "general",
      prompt: "Hello",
    });
  });

  it("rejects a non-object params", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", params: ["x"], args: {} }),
      /^params must be an object\.$/,
    );
  });

  it("passes reserved $params keys through $type json", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      args: {
        $inline: '{"prompt":"hi","$params":{"name":"X"}}',
        $type: "json",
      },
    });

    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({
      prompt: "hi",
      $params: { name: "X" },
    });
  });

  it("accepts args as a JSON object string", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      args: JSON.stringify({
        prompt: { $inline: "Hi {{name}}", $params: { name: "X" } },
      }),
    });

    expect(calls[0].prompt).toBe("Hi X");
  });

  it("rejects JSON string arrays and primitives as args", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    for (const args of ["[]", "[1,2]", "42", '"text"', "null", "true"]) {
      await expectToolFailure(
        h.callTool({ tool: "subagent", args }),
        /^args must be a JSON object\.$/,
      );
    }
  });

  it("accepts a whole-args template", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      args: {
        $inline: '{"agent":"general","prompt":"{{prompt}}"}',
        $type: "json",
        $params: { prompt: "Hello" },
      },
    });

    expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({
      agent: "general",
      prompt: "Hello",
    });
  });

  it("reports only allowed registered tools for an unknown target", async () => {
    const h = makeHarness({ options: { allowedTools: ["missing", "read"] } });
    h.addTarget({ id: "read" });
    h.addTarget({ id: "write" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "missing", args: {} }),
      /^Unknown tool "missing"\. Available tools: read\.$/,
    );
  });

  it("does not list target inventory without allowedTools", async () => {
    const h = makeHarness();
    h.addTarget({ id: "read" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "missing", args: {} }),
      /^Unknown tool "missing"\.$/,
    );
  });

  it("reports an unknown target when no tools are registered", async () => {
    const h = makeHarness();
    h.ctx.tool.list = async () => [];
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "missing", args: {} }),
      /^Unknown tool "missing"\.$/,
    );
  });

  it("omits denied tools from the unknown-target list", async () => {
    const h = makeHarness({
      options: {
        allowedTools: ["missing", "read", "bash"],
        deniedTools: ["Bash"],
      },
    });
    h.addTarget({ id: "read" });
    h.addTarget({ id: "bash" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "missing", args: {} }),
      /^Unknown tool "missing"\. Available tools: read\.$/,
    );
  });

  it("omits template_call itself from the unknown-target list", async () => {
    const h = makeHarness({
      options: { allowedTools: ["missing", "template_call", "read"] },
    });
    h.addTarget({ id: "read" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "missing", args: {} }),
      /^Unknown tool "missing"\. Available tools: read\.$/,
    );
  });

  it("truncates the unknown-target tool list after 50 names", async () => {
    const tools = Array.from({ length: 55 }, (_, index) => ({
      id: `tool_${String(index).padStart(2, "0")}`,
    }));
    const h = makeHarness({
      options: { allowedTools: ["missing", ...tools.map((tool) => tool.id)] },
    });
    h.ctx.tool.list = async () => tools;
    await h.setup();
    const visible = tools.map((tool) => tool.id).slice(0, 50);
    const expected = `Unknown tool "missing". Available tools: ${visible.join(", ")}, ....`;

    try {
      await h.callTool({ tool: "missing", args: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as Error).message).toBe(expected);
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("refuses to call itself", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(h.callTool({ tool: "template_call", args: {} })).rejects.toThrow(
      /cannot call itself/,
    );
  });

  it("refuses to call itself under a custom namespace", async () => {
    const h = makeHarness({ options: { namespace: "custom.templates" } });
    await h.setup();

    await expect(h.callTool({ tool: "custom_templates_call", args: {} })).rejects.toThrow(
      /cannot call itself/,
    );
  });

  it("enforces allowedTools and deniedTools", async () => {
    const allowed = makeHarness({ options: { allowedTools: ["subagent"] } });
    allowed.addTarget({ id: "subagent" });
    allowed.addTarget({ id: "read" });
    await allowed.setup();
    await expect(allowed.callTool({ tool: "read", args: {} })).rejects.toThrow(
      /allowedTools/,
    );

    const denied = makeHarness({ options: { deniedTools: ["subagent"] } });
    denied.addTarget({ id: "subagent" });
    await denied.setup();
    await expect(denied.callTool({ tool: "subagent", args: {} })).rejects.toThrow(
      /deniedTools/,
    );
  });

  it("applies target rules in order", async () => {
    const h = makeHarness({
      options: { allowedTools: ["other"], deniedTools: ["subagent"] },
    });
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", args: {} }),
      /^Tool "subagent" is not in allowedTools\.$/,
    );
  });

  it("matches deniedTools case-insensitively and allowedTools exactly", async () => {
    const denied = makeHarness({ options: { deniedTools: ["Bash"] } });
    denied.addTarget({ id: "bash" });
    await denied.setup();
    await expectToolFailure(
      denied.callTool({ tool: "bash", args: {} }),
      /^Tool "bash" is denied by deniedTools\.$/,
    );

    const exactDenied = makeHarness({ options: { deniedTools: ["bash"] } });
    exactDenied.addTarget({ id: "bash" });
    await exactDenied.setup();
    await expectToolFailure(
      exactDenied.callTool({ tool: "bash", args: {} }),
      /^Tool "bash" is denied by deniedTools\.$/,
    );

    const allowed = makeHarness({ options: { allowedTools: ["Bash"] } });
    allowed.addTarget({ id: "bash" });
    await allowed.setup();
    await expectToolFailure(
      allowed.callTool({ tool: "bash", args: {} }),
      /^Tool "bash" is not in allowedTools\.$/,
    );
  });

  it("ignores inherited tool and renderOnly properties", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expectToolFailure(
      h.callTool(Object.assign(Object.create({ tool: "subagent" }), { args: {} })),
      /^tool is required\.$/,
    );

    const result = await h.callTool(
      Object.assign(Object.create({ renderOnly: true }), {
        tool: "subagent",
        args: {},
      }),
    );
    expect(calls).toHaveLength(1);
    expect(result.content).toBe("ok");
  });

  it("wraps target errors with the target name and preserves the cause", async () => {
    const h = makeHarness();
    const original = new ToolError({ message: "boom" });
    h.addTarget({
      id: "subagent",
      execute: async () => {
        throw original;
      },
    });
    await h.setup();

    const error = await captureToolFailure(h.callTool({ tool: "subagent", args: {} }));
    expect(error.message).toBe('Target tool "subagent" failed: boom');
    expect(error.error).toBe(original);
  });

  it("wraps non-tool target errors and preserves the cause", async () => {
    const h = makeHarness();
    const original = new Error("plain");
    h.addTarget({
      id: "subagent",
      execute: async () => {
        throw original;
      },
    });
    await h.setup();

    const error = await captureToolFailure(h.callTool({ tool: "subagent", args: {} }));
    expect(error.message).toBe('Target tool "subagent" failed: plain');
    expect(error.error).toBe(original);
  });

  it("passes target error content through unchanged", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "read",
      execute: async () => ({ content: "File not found: x" }),
    });
    h.addTarget({
      id: "edit",
      execute: async () => ({ content: "Could not find oldString: y" }),
    });
    await h.setup();

    const read = await h.callTool({ tool: "read", args: {} });
    expect(read.content).toBe("File not found: x");

    const edit = await h.callTool({ tool: "edit", args: {} });
    expect(edit.content).toBe("Could not find oldString: y");
  });

  it("uses a message from a non-Error target throw", async () => {
    const h = makeHarness();
    const thrown = { message: "boom" };
    h.addTarget({
      id: "subagent",
      execute: async () => {
        throw thrown;
      },
    });
    await h.setup();

    const error = await captureToolFailure(h.callTool({ tool: "subagent", args: {} }));
    expect(error.message).toBe('Target tool "subagent" failed: boom');
    expect(error.error).toBe(thrown);
  });

  it("describes non-Error target throws safely", async () => {
    const h = makeHarness();
    const emptyObject = {};
    const object = { code: "E_TARGET", detail: "boom" };
    const longObject = { text: "x".repeat(300) };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    h.addTarget({
      id: "string-throw",
      execute: async () => {
        throw "boom";
      },
    });
    h.addTarget({
      id: "empty-object-throw",
      execute: async () => {
        throw emptyObject;
      },
    });
    h.addTarget({
      id: "object-throw",
      execute: async () => {
        throw object;
      },
    });
    h.addTarget({
      id: "long-object-throw",
      execute: async () => {
        throw longObject;
      },
    });
    h.addTarget({
      id: "circular-throw",
      execute: async () => {
        throw circular;
      },
    });
    await h.setup();

    const stringError = await captureToolFailure(
      h.callTool({ tool: "string-throw", args: {} }),
    );
    expect(stringError.message).toBe('Target tool "string-throw" failed: boom');
    expect(stringError.error).toBe("boom");

    const emptyError = await captureToolFailure(
      h.callTool({ tool: "empty-object-throw", args: {} }),
    );
    expect(emptyError.message).toBe('Target tool "empty-object-throw" failed: {}');
    expect(emptyError.error).toBe(emptyObject);

    const objectError = await captureToolFailure(
      h.callTool({ tool: "object-throw", args: {} }),
    );
    expect(objectError.message).toBe(
      'Target tool "object-throw" failed: {"code":"E_TARGET","detail":"boom"}',
    );
    expect(objectError.error).toBe(object);

    const longError = await captureToolFailure(
      h.callTool({ tool: "long-object-throw", args: {} }),
    );
    const longPrefix = 'Target tool "long-object-throw" failed: ';
    expect(longError.message.startsWith(longPrefix)).toBe(true);
    expect(longError.message).toHaveLength(longPrefix.length + 203);
    expect(longError.message.endsWith("...")).toBe(true);
    expect(longError.error).toBe(longObject);

    const circularError = await captureToolFailure(
      h.callTool({ tool: "circular-throw", args: {} }),
    );
    expect(circularError.message).toBe(
      'Target tool "circular-throw" failed: [unserializable object]',
    );
    expect(circularError.error).toBe(circular);
  });

  it("falls back to target output when content is missing", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({ output: { a: 1 } }),
    });
    await h.setup();

    const result = await h.callTool({ tool: "subagent", args: {} });
    expect(result.content).toBe('{"a":1}');

    h.addTarget({ id: "empty", execute: async () => ({}) });
    const empty = await h.callTool({ tool: "empty", args: {} });
    expect(empty.content).toBe("");
  });

  it("falls back when a target returns null content", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "with-output",
      execute: async () => ({ content: null, output: { a: 1 } }),
    });
    h.addTarget({ id: "without-output", execute: async () => ({ content: null }) });
    await h.setup();

    const withOutput = await h.callTool({ tool: "with-output", args: {} });
    expect(withOutput.content).toBe('{"a":1}');

    const withoutOutput = await h.callTool({ tool: "without-output", args: {} });
    expect(withoutOutput.content).toBe("");
  });

  it("fails closed for non-record target results", async () => {
    const h = makeHarness();
    const cases = [
      { id: "undefined-result", value: undefined },
      { id: "null-result", value: null },
      { id: "number-result", value: 42 },
      { id: "string-result", value: "text" },
      { id: "array-result", value: [] },
      { id: "boolean-result", value: true },
    ];
    for (const testCase of cases) {
      h.addTarget({ id: testCase.id, execute: async () => testCase.value });
    }
    await h.setup();

    for (const testCase of cases) {
      await expectToolFailure(
        h.callTool({ tool: testCase.id, args: {} }),
        new RegExp(`^Target tool "${testCase.id}" returned an invalid result\\.$`),
      );
    }
  });

  it("fails closed for invalid target content", async () => {
    const h = makeHarness();
    const cases = [
      { id: "number-content", value: 42 },
      { id: "boolean-content", value: true },
      { id: "object-content", value: { text: "x" } },
    ];
    for (const testCase of cases) {
      h.addTarget({
        id: testCase.id,
        execute: async () => ({ content: testCase.value }),
      });
    }
    await h.setup();

    for (const testCase of cases) {
      await expectToolFailure(
        h.callTool({ tool: testCase.id, args: {} }),
        new RegExp(
          `^Target tool "${testCase.id}" returned invalid content; expected a string or content array\\.$`,
        ),
      );
    }
  });

  it("fails closed for non-serializable target output", async () => {
    const h = makeHarness();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    h.addTarget({ id: "bigint-text", execute: async () => ({ output: 1n }) });
    h.addTarget({
      id: "bigint-json",
      execute: async () => ({ content: "ok", output: 1n }),
    });
    h.addTarget({ id: "circular-text", execute: async () => ({ output: circular }) });
    h.addTarget({
      id: "circular-json",
      execute: async () => ({ content: "ok", output: circular }),
    });
    h.addTarget({
      id: "function-output",
      execute: async () => ({ output: () => undefined }),
    });
    h.addTarget({
      id: "symbol-output",
      execute: async () => ({ output: Symbol("output") }),
    });
    await h.setup();

    for (const tool of ["bigint-text", "circular-text"]) {
      await expectToolFailure(
        h.callTool({ tool, args: {} }),
        new RegExp(
          `^Target tool "${tool}" returned invalid output; expected a JSON-serializable value\\.$`,
        ),
      );
    }
    for (const tool of [
      "bigint-json",
      "circular-json",
      "function-output",
      "symbol-output",
    ]) {
      await expectToolFailure(
        h.callTool({ tool, args: {}, format: "json" }),
        new RegExp(
          `^Target tool "${tool}" returned invalid output; expected a JSON-serializable value\\.$`,
        ),
      );
    }
  });

  it("rejects an unsupported output format before touching the target", async () => {
    const renderer: ChainRenderer = {
      renderValue: rejectUnexpectedDispatch,
      renderArgs: rejectUnexpectedDispatch,
      renderTemplateValue: rejectUnexpectedDispatch,
    };
    const deps: DispatchDeps = {
      config: resolveConfig({ allowedOutputFormats: ["text"] }),
      renderer,
      permission: { assert: rejectUnexpectedDispatch },
      toolList: rejectUnexpectedDispatch,
      selfToolName: "template_call",
    };

    await expectToolFailure(
      dispatchCall({ tool: "subagent", args: {} }, makeToolContext(), deps, {
        strategy: resolveOutputStrategy(["text"]),
        format: "json" as OutputFormat,
      }),
      /^Unsupported output format: json$/,
    );
  });

  it("keeps null target output", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent", execute: async () => ({ output: null }) });
    await h.setup();

    const text = await h.callTool({ tool: "subagent", args: {} });
    expect(text.content).toBe("null");
    expect(text.output).toEqual({ tool: "subagent", output: null });

    const json = await h.callTool({ tool: "subagent", args: {}, format: "json" });
    expect(JSON.parse(json.content)).toEqual({ tool: "subagent", output: null });
    expect(json.output).toEqual({ tool: "subagent", output: null });
  });

  it("does not validate unused output in text-only mode", async () => {
    const textOnly = makeHarness({ options: { allowedOutputFormats: ["text"] } });
    textOnly.addTarget({
      id: "subagent",
      execute: async () => ({ content: "ok", output: 1n }),
    });
    await textOnly.setup();

    const result = await textOnly.callTool({ tool: "subagent", args: {} });
    expect(result.content).toBe("ok");
    expect(result.output).toBeUndefined();

    const both = makeHarness();
    both.addTarget({
      id: "subagent",
      execute: async () => ({ content: "ok", output: 1n }),
    });
    await both.setup();

    await expectToolFailure(
      both.callTool({ tool: "subagent", args: {} }),
      /returned invalid output/,
    );
  });

  it("validates output used as the text-only fallback", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } });
    h.addTarget({
      id: "subagent",
      execute: async () => ({ content: null, output: 1n }),
    });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", args: {} }),
      /returned invalid output/,
    );
  });

  it("returns JSON content and structured output in json mode", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({
        content: "text result",
        output: { sessionID: "ses_child", status: "completed" },
      }),
    });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: {},
      format: "json",
    });

    expect(result.content).toBe(
      JSON.stringify(
        {
          tool: "subagent",
          output: { sessionID: "ses_child", status: "completed" },
        },
        null,
        2,
      ),
    );
    expect(JSON.parse(result.content)).toEqual({
      tool: "subagent",
      output: { sessionID: "ses_child", status: "completed" },
    });
    expect(result.output).toEqual({
      tool: "subagent",
      output: { sessionID: "ses_child", status: "completed" },
    });
  });

  it("defaults to text when both formats are allowed", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({
        content: "text result",
        output: { sessionID: "ses_child" },
      }),
    });
    await h.setup();

    const result = await h.callTool({ tool: "subagent", args: {} });

    expect(result.content).toBe("text result");
    expect(result.output).toEqual({
      tool: "subagent",
      output: { sessionID: "ses_child" },
    });
  });

  it("falls back to text for an invalid format when both formats are allowed", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({ content: "text result", output: { ok: true } }),
    });
    await h.setup();

    // The input schema normally restricts format to the enum; call the tool
    // directly to cover the runtime fallback as well.
    for (const format of ["xml", "constructor", 42]) {
      const result = await h.callTool({ tool: "subagent", args: {}, format });
      expect(result.content).toBe("text result");
      expect(result.output).toEqual({ tool: "subagent", output: { ok: true } });
    }
  });

  it("keeps target content in text mode", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({
        content: "text result",
        output: { sessionID: "ses_child" },
      }),
    });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: {},
      format: "text",
    });

    expect(result.content).toBe("text result");
    expect(result.output).toEqual({
      tool: "subagent",
      output: { sessionID: "ses_child" },
    });
  });

  it("omits output in text-only mode", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } });
    h.addTarget({
      id: "subagent",
      execute: async () => ({
        content: "text result",
        output: { sessionID: "ses_child" },
      }),
    });
    await h.setup();

    const result = await h.callTool({ tool: "subagent", args: {} });
    expect(result.content).toBe("text result");
    expect(result.output).toBeUndefined();
  });

  it("forces JSON in json-only mode", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["json"] } });
    h.addTarget({
      id: "subagent",
      execute: async () => ({
        content: "text result",
        output: { sessionID: "ses_child" },
      }),
    });
    await h.setup();

    const result = await h.callTool({ tool: "subagent", args: {} });
    expect(JSON.parse(result.content)).toEqual({
      tool: "subagent",
      output: { sessionID: "ses_child" },
    });
  });

  it("validates Effect Schema target input", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: Schema.Struct({ text: Schema.String }),
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: { text: 42 } })).rejects.toThrow(
      /Invalid arguments for target tool "subagent"/,
    );

    await h.callTool({ tool: "subagent", args: { text: "hi" } });
    expect(calls[0].text).toBe("hi");
  });

  it("validates Standard Schema target input", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: {
        "~standard": {
          validate: (value: any) =>
            value && typeof value.text === "string"
              ? { value }
              : { issues: [{ message: "text must be a string" }] },
        },
      },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: { text: 42 } })).rejects.toThrow(
      /text must be a string/,
    );

    await h.callTool({ tool: "subagent", args: { text: "hi" } });
    expect(calls[0].text).toBe("hi");
  });

  it("validates JSON Schema target input", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: { count: "2" } })).rejects.toThrow(
      /Invalid arguments/,
    );

    await h.callTool({ tool: "subagent", args: { count: 2 } });
    expect(calls[0].count).toBe(2);
  });

  it("enforces additionalProperties: false for JSON Schema objects", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    const closedSchema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    };
    h.addTarget({
      id: "closed",
      input: closedSchema,
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    h.addTarget({
      id: "open",
      input: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expect(
      h.callTool({ tool: "closed", args: { count: 2, extra: true } }),
    ).rejects.toThrow(/Invalid arguments/);
    expect(calls).toEqual([]);

    await h.callTool({ tool: "closed", args: { count: 2 } });
    expect(calls[0]).toEqual({ count: 2 });

    await h.callTool({ tool: "open", args: { count: 2, extra: true } });
    expect(calls[1]).toEqual({ count: 2, extra: true });
  });

  it("uses a transformed Effect Schema value for execute", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: Schema.Struct({ count: Schema.NumberFromString }),
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { count: "2" } });

    expect(calls[0]).toEqual({ count: 2 });
  });

  it("uses a transformed Standard Schema value for execute", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: {
        "~standard": {
          validate: (value: any) => ({ value: { ...value, transformed: true } }),
        },
      },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { text: "hi" } });

    expect(calls[0]).toEqual({ text: "hi", transformed: true });
  });

  it("uses a decoded undefined value for execute", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: { "~standard": { validate: () => ({ value: undefined }) } },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: {} });

    expect(calls[0]).toBeUndefined();
  });

  it("rejects a Standard Schema with empty issues and no value", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      input: { "~standard": { validate: () => ({ issues: [] }) } },
    });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: {} })).rejects.toThrow(
      /issues without a value/,
    );
  });

  it("fails closed for malformed Standard Schema results", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "empty",
      input: { "~standard": { validate: () => ({}) } },
    });
    h.addTarget({
      id: "undefined-issues",
      input: { "~standard": { validate: () => ({ issues: undefined }) } },
    });
    await h.setup();

    await expect(h.callTool({ tool: "empty", args: {} })).rejects.toThrow(
      /neither a value nor issues/,
    );
    await expect(h.callTool({ tool: "undefined-issues", args: {} })).rejects.toThrow(
      /invalid issues/,
    );
  });

  it("rejects malformed Standard Schema issue paths and issues", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "string-path",
      input: {
        "~standard": {
          validate: () => ({ issues: [{ path: "flag", message: "bad" }] }),
        },
      },
    });
    h.addTarget({
      id: "object-path",
      input: {
        "~standard": {
          validate: () => ({ issues: [{ path: { flag: true }, message: "bad" }] }),
        },
      },
    });
    h.addTarget({
      id: "non-array-issues",
      input: { "~standard": { validate: () => ({ issues: "bad" }) } },
    });
    await h.setup();

    for (const tool of ["string-path", "object-path", "non-array-issues"]) {
      await expectToolFailure(
        h.callTool({ tool, args: {} }),
        /Standard Schema returned invalid issues/,
      );
    }
  });

  it("rejects a Standard Schema issue path with a shadowed map method", async () => {
    const h = makeHarness();
    const path: any = [];
    path.map = null;
    h.addTarget({
      id: "subagent",
      input: {
        "~standard": {
          validate: () => ({ issues: [{ path, message: "bad" }] }),
        },
      },
    });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", args: {} }),
      /Standard Schema returned invalid issues/,
    );
  });

  it("wraps a throwing Standard Schema validate as a Tool.Error", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      input: {
        "~standard": {
          validate: () => {
            throw new TypeError("boom");
          },
        },
      },
    });
    await h.setup();

    await expectToolFailure(h.callTool({ tool: "subagent", args: {} }), /boom/);
  });

  it("rejects a non-object Standard Schema result", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      input: { "~standard": { validate: () => "nope" } },
    });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", args: {} }),
      /Standard Schema returned an invalid result/,
    );
  });

  it("accepts an empty issues list with an explicit value", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: { "~standard": { validate: () => ({ issues: [], value: undefined }) } },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: {} });

    expect(calls[0]).toBeUndefined();
  });

  it("rejects non-plain JSON Schema objects", async () => {
    const h = makeHarness();
    h.addTarget({ id: "date", input: new Date() });
    h.addTarget({ id: "map", input: new Map() });
    h.addTarget({ id: "set", input: new Set() });
    await h.setup();

    for (const tool of ["date", "map", "set"]) {
      await expect(h.callTool({ tool, args: {} })).rejects.toThrow(
        /unsupported target input schema/,
      );
    }
  });

  it("supports async Standard Schema validation", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: {
        "~standard": {
          validate: async (value: any) => ({ value: { ...value, async: true } }),
        },
      },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { text: "hi" } });

    expect(calls[0]).toEqual({ text: "hi", async: true });
  });

  it("validates draft-07 JSON Schema with definitions", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: {
        $schema: "http://json-schema.org/draft-07/schema#",
        definitions: { text: { type: "string" } },
        type: "object",
        properties: { text: { $ref: "#/definitions/text" } },
        required: ["text"],
      },
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: { text: 1 } })).rejects.toThrow(
      /Invalid arguments/,
    );
    await h.callTool({ tool: "subagent", args: { text: "hi" } });
    expect(calls[0]).toEqual({ text: "hi" });
  });

  it("ignores inherited JSON Schema definitions", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    // A Proxy models a plain object with an inherited `definitions` property;
    // `isPlainRecord` still sees Object.prototype as the prototype.
    const schema = new Proxy(draftSensitiveSchema(), {
      has: (target, key) => key === "definitions" || Object.hasOwn(target, key),
      get: (target, key) =>
        key === "definitions"
          ? { text: { type: "string" } }
          : (target as Record<PropertyKey, unknown>)[key],
    });
    h.addTarget({
      id: "subagent",
      input: schema,
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { values: ["x", "y"] } });
    expect(calls).toEqual([{ values: ["x", "y"] }]);
  });

  it("ignores inherited JSON Schema $schema", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    const schema = new Proxy(draftSensitiveSchema(), {
      has: (target, key) => key === "$schema" || Object.hasOwn(target, key),
      get: (target, key) =>
        key === "$schema"
          ? "http://json-schema.org/draft-07/schema#"
          : (target as Record<PropertyKey, unknown>)[key],
    });
    h.addTarget({
      id: "subagent",
      input: schema,
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { values: ["x", "y"] } });
    expect(calls).toEqual([{ values: ["x", "y"] }]);
  });

  it("accepts values through a schema that allows unknown input", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      input: Schema.Unknown,
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { anything: 1 } });

    expect(calls[0]).toEqual({ anything: 1 });
  });

  it("treats undefined and null target schemas as unconstrained", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    for (const [id, input] of [
      ["undefined", undefined],
      ["null", null],
    ] as const) {
      h.addTarget({
        id,
        input,
        execute: async (args: any) => {
          calls.push(args);
          return { content: "ok" };
        },
      });
    }
    await h.setup();

    await h.callTool({ tool: "undefined", args: { anything: 1 } });
    await h.callTool({ tool: "null", args: { anything: 2 } });

    expect(calls).toEqual([{ anything: 1 }, { anything: 2 }]);
  });

  it("rejects a false JSON Schema", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent", input: false });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: {} })).rejects.toThrow(
      /rejects all values/,
    );
  });

  it("accepts a prototype getter ~standard schema", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    class PrototypeStandardSchema {
      get "~standard"() {
        return {
          validate: (value: any) => ({ value: { ...value, validated: true } }),
        };
      }
    }
    h.addTarget({
      id: "subagent",
      input: new PrototypeStandardSchema(),
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "subagent", args: { text: "hi" } });

    expect(calls[0]).toEqual({ text: "hi", validated: true });
  });

  it("rejects an unsupported target input schema", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent", input: 42 });
    await h.setup();

    await expect(h.callTool({ tool: "subagent", args: {} })).rejects.toThrow(
      /unsupported target input schema/,
    );
  });

  it("adds a $type hint to validation errors", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      input: Schema.Struct({ flag: Schema.Boolean }),
    });
    await h.setup();

    await expect(
      h.callTool({ tool: "subagent", args: { flag: "true" } }),
    ).rejects.toThrow(/render it with \$type/);
  });

  it("includes Standard Schema issue paths in validation errors", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      input: {
        "~standard": {
          validate: () => ({
            issues: [{ path: ["flag"], message: "must be a boolean" }],
          }),
        },
      },
    });
    await h.setup();

    await expect(
      h.callTool({ tool: "subagent", args: { flag: "true" } }),
    ).rejects.toThrow(/flag: must be a boolean/);
  });

  it("returns only the tool name in json mode when output is missing", async () => {
    const h = makeHarness();
    h.addTarget({ id: "empty", execute: async () => ({}) });
    await h.setup();

    const result = await h.callTool({ tool: "empty", args: {}, format: "json" });

    expect(JSON.parse(result.content)).toEqual({ tool: "empty" });
    expect(result.output).toEqual({ tool: "empty" });
  });

  it("preserves target error metadata", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => {
        throw new ToolError({ message: "boom", metadata: { code: "x" } });
      },
    });
    await h.setup();

    try {
      await h.callTool({ tool: "subagent", args: {} });
    } catch (error) {
      expect((error as ToolError).metadata).toEqual({ code: "x" });
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("passes target metadata through", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      execute: async () => ({
        content: "ok",
        metadata: { foo: "bar", templateTarget: "other" },
      }),
    });
    await h.setup();

    const result = await h.callTool({ tool: "subagent", args: {} });
    expect(result.metadata).toEqual({ foo: "bar", templateTarget: "subagent" });
  });

  it("ignores non-record target metadata", async () => {
    const h = makeHarness();
    const cases = [
      { id: "string-metadata", value: "meta" },
      { id: "array-metadata", value: ["a", "b"] },
      { id: "number-metadata", value: 42 },
      { id: "null-metadata", value: null },
    ];
    for (const testCase of cases) {
      h.addTarget({
        id: testCase.id,
        execute: async () => ({ content: "ok", metadata: testCase.value }),
      });
    }
    await h.setup();

    for (const testCase of cases) {
      const result = await h.callTool({ tool: testCase.id, args: {} });
      expect(result.metadata).toEqual({ templateTarget: testCase.id });
    }
  });

  it("returns target content arrays unchanged", async () => {
    const h = makeHarness();
    const content = [{ type: "text", text: "a" }];
    h.addTarget({
      id: "subagent",
      execute: async () => ({ content }),
    });
    await h.setup();

    const result = await h.callTool({ tool: "subagent", args: {} });
    expect(result.content).toEqual(content);
  });

  it("does not call the target when the signal is already aborted", async () => {
    const h = makeHarness();
    let called = false;
    h.addTarget({
      id: "subagent",
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    await h.setup();
    const controller = new AbortController();
    controller.abort();

    try {
      await h.callTool(
        { tool: "subagent", args: {} },
        makeToolContext({ signal: controller.signal }),
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(called).toBe(false);
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("aborts after a template permission check without calling the target", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("task.md", "Task");
    let called = false;
    h.addTarget({
      id: "demo",
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    const controller = new AbortController();
    const assert = h.ctx.permission.assert;
    h.ctx.permission.assert = async (value: any) => {
      await assert(value);
      controller.abort();
    };

    try {
      await h.callTool(
        { tool: "demo", args: { prompt: { $file: "task.md" } } },
        makeToolContext({ signal: controller.signal }),
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(called).toBe(false);
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("does not wrap a target error after abort", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    h.addTarget({
      id: "subagent",
      execute: async () => {
        controller.abort();
        throw new Error("interrupted");
      },
    });
    await h.setup();

    try {
      await h.callTool(
        { tool: "subagent", args: {} },
        makeToolContext({ signal: controller.signal }),
      );
    } catch (error) {
      expect((error as Error).message).toBe("interrupted");
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("renderOnly does not call the target", async () => {
    const h = makeHarness();
    let called = false;
    h.addTarget({
      id: "subagent",
      execute: async () => {
        called = true;
        return { content: "x" };
      },
    });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: { prompt: { $inline: "Hi {{name}}", $params: { name: "X" } } },
      renderOnly: true,
    });

    expect(called).toBe(false);
    expect(result.content.trim().startsWith("{")).toBe(true);
    expect(result.content).toContain('"prompt": "Hi X"');
    expect(result.metadata).toEqual({ templateTarget: "subagent" });
  });

  it("returns structured renderOnly output when JSON is allowed", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: { prompt: "hi" },
      renderOnly: true,
    });

    expect(result.output).toEqual({ tool: "subagent", args: { prompt: "hi" } });
  });

  it("omits renderOnly output in text-only mode", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["text"] } });
    h.addTarget({ id: "subagent" });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: { prompt: "hi" },
      renderOnly: true,
    });

    expect(result.output).toBeUndefined();
  });

  it("includes renderOnly output in json-only mode", async () => {
    const h = makeHarness({ options: { allowedOutputFormats: ["json"] } });
    h.addTarget({ id: "subagent" });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: { prompt: "hi" },
      renderOnly: true,
    });

    expect(result.output).toEqual({ tool: "subagent", args: { prompt: "hi" } });
  });

  it("does not validate target input for renderOnly", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "subagent",
      input: Schema.Struct({ required: Schema.String }),
    });
    await h.setup();

    const result = await h.callTool({
      tool: "subagent",
      args: {},
      renderOnly: true,
    });

    expect(result.output).toEqual({ tool: "subagent", args: {} });
  });

  it("rejects renderOnly for an unknown target", async () => {
    const h = makeHarness();
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "missing", args: {}, renderOnly: true }),
      /^Unknown tool "missing"\.$/,
    );
  });

  it("rejects renderOnly for a denied target", async () => {
    const h = makeHarness({ options: { deniedTools: ["subagent"] } });
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", args: {}, renderOnly: true }),
      /^Tool "subagent" is denied by deniedTools\.$/,
    );
  });

  it("reads file templates and checks read permission", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("templates/task.md", "Task {{TASK_ID}}");
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });

    const result = await h.callTool({
      tool: "subagent",
      args: {
        prompt: { $file: "templates/task.md", $params: { TASK_ID: "T-1" } },
      },
    });

    expect(calls[0].prompt).toBe("Task T-1");
    expect(h.permissionCalls.some((call) => call.action === "read")).toBe(true);
    expect(result.content).toBe("ok");
  });

  it("reads a whole-args $file template object and calls the target", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("args.json", '{"agent":"general","prompt":"Hi {{name}}"}');
    const calls: any[] = [];
    h.addTarget({
      id: "subagent",
      execute: async (args: any) => {
        calls.push(args);
        return { content: "ok" };
      },
    });

    const result = await h.callTool({
      tool: "subagent",
      args: { $file: "args.json", $params: { name: "X" } },
    });

    expect(calls[0]).toEqual({ agent: "general", prompt: "Hi X" });
    expect(result.content).toBe("ok");
    expect(h.permissionCalls.some((call) => call.action === "read")).toBe(true);
  });

  it("propagates a read permission denial", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("task.md", "Task");
    h.addTarget({ id: "subagent" });
    h.setPermissionError(new ToolError({ message: "read denied" }));

    await expect(
      h.callTool({
        tool: "subagent",
        args: { prompt: { $file: "task.md" } },
      }),
    ).rejects.toThrow(/read denied/);
  });

  it("does not pre-assert a target's declared permission", async () => {
    const h = makeHarness();
    let called = false;
    h.addTarget({
      id: "demo",
      options: { permission: "demo" },
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    await h.setup();

    const result = await h.callTool({ tool: "demo", args: {} });

    expect(called).toBe(true);
    expect(h.permissionCalls).toEqual([]);
    expect(result.content).toBe("ok");
  });

  it("delegates target permission with the rendered path", async () => {
    const h = makeHarness();
    usePermissionRules(h, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "runs/**", effect: "allow" },
    ]);
    const writes: string[] = [];
    h.addTarget({
      id: "write",
      options: { permission: "edit" },
      execute: async (args: any) => {
        await h.ctx.permission.assert({
          sessionID: "ses_test",
          action: "edit",
          resources: [args.path],
          save: ["*"],
        });
        writes.push(args.path);
        return { content: "ok" };
      },
    });
    await h.setup();

    const result = await h.callTool({
      tool: "write",
      args: { path: "runs/log.md", content: { $inline: "hello" } },
    });

    expect(result.content).toBe("ok");
    expect(writes).toEqual(["runs/log.md"]);
    expect(h.permissionCalls).toEqual([
      expect.objectContaining({ action: "edit", resources: ["runs/log.md"] }),
    ]);
    expect(h.permissionCalls.some((call) => call.resources.includes("*"))).toBe(false);
  });

  it("lets the target deny a path outside its scoped allow", async () => {
    const h = makeHarness();
    usePermissionRules(h, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "runs/**", effect: "allow" },
    ]);
    const writes: string[] = [];
    h.addTarget({
      id: "write",
      options: { permission: "edit" },
      execute: async (args: any) => {
        await h.ctx.permission.assert({
          sessionID: "ses_test",
          action: "edit",
          resources: [args.path],
          save: ["*"],
        });
        writes.push(args.path);
        return { content: "ok" };
      },
    });
    await h.setup();

    await expectToolFailure(
      h.callTool({
        tool: "write",
        args: { path: "src/Program.cs", content: "x" },
      }),
      /^Target tool "write" failed: Permission denied: edit$/,
    );

    expect(writes).toEqual([]);
    expect(h.permissionCalls.some((call) => call.resources[0] === "src/Program.cs")).toBe(
      true,
    );
  });

  it("delegates shell permission with the rendered command", async () => {
    const h = makeHarness();
    usePermissionRules(h, [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git status*", effect: "allow" },
    ]);
    const commands: string[] = [];
    h.addTarget({
      id: "shell",
      options: { permission: "shell" },
      execute: async (args: any) => {
        await h.ctx.permission.assert({
          sessionID: "ses_test",
          action: "shell",
          resources: [args.command],
          save: [args.command],
        });
        commands.push(args.command);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "shell",
      args: { command: "git status --porcelain" },
    });
    await expectToolFailure(
      h.callTool({ tool: "shell", args: { command: "rm -rf /" } }),
      /^Target tool "shell" failed: Permission denied: shell$/,
    );

    expect(commands).toEqual(["git status --porcelain"]);
  });

  it("delegates subagent permission with the rendered agent", async () => {
    const h = makeHarness();
    usePermissionRules(h, [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "reviewer", effect: "allow" },
    ]);
    const agents: string[] = [];
    h.addTarget({
      id: "subagent",
      options: { permission: "subagent" },
      execute: async (args: any) => {
        await h.ctx.permission.assert({
          sessionID: "ses_test",
          action: "subagent",
          resources: [args.agent],
          save: [args.agent],
        });
        agents.push(args.agent);
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({
      tool: "subagent",
      args: { agent: "reviewer", prompt: "hi" },
    });
    await expectToolFailure(
      h.callTool({ tool: "subagent", args: { agent: "general", prompt: "hi" } }),
      /^Target tool "subagent" failed: Permission denied: subagent$/,
    );

    expect(agents).toEqual(["reviewer"]);
  });

  it("propagates a target permission denial from the target executor", async () => {
    const h = makeHarness();
    let called = false;
    h.addTarget({
      id: "demo",
      execute: async () => {
        await h.ctx.permission.assert({
          sessionID: "ses_test",
          action: "demo",
          resources: ["x"],
          save: ["*"],
        });
        called = true;
        return { content: "ok" };
      },
    });
    await h.setup();
    h.setPermissionError(new ToolError({ message: "demo denied" }));

    const error = await captureToolFailure(h.callTool({ tool: "demo", args: {} }));
    expect(error.message).toBe('Target tool "demo" failed: demo denied');
    expect(error.error).toBeInstanceOf(ToolError);
    expect(called).toBe(false);
  });

  it("does not assert permission for targets without one", async () => {
    const h = makeHarness();
    const calls: string[] = [];
    h.addTarget({
      id: "plain",
      execute: async () => {
        calls.push("plain");
        return { content: "ok" };
      },
    });
    h.addTarget({
      id: "empty",
      options: { permission: "" },
      execute: async () => {
        calls.push("empty");
        return { content: "ok" };
      },
    });
    await h.setup();

    await h.callTool({ tool: "plain", args: {} });
    await h.callTool({ tool: "empty", args: {} });

    expect(calls).toEqual(["plain", "empty"]);
    expect(h.permissionCalls).toEqual([]);
  });

  it("ignores a non-string target permission", async () => {
    const h = makeHarness();
    let called = false;
    h.addTarget({
      id: "demo",
      options: { permission: 42 },
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    await h.setup();

    const result = await h.callTool({ tool: "demo", args: {} });

    expect(called).toBe(true);
    expect(h.permissionCalls).toEqual([]);
    expect(result.content).toBe("ok");
  });

  it("does not assert target permission for renderOnly", async () => {
    const h = makeHarness();
    usePermissionRules(h, [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "runs/**", effect: "allow" },
    ]);
    let called = false;
    h.addTarget({
      id: "write",
      options: { permission: "edit" },
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    await h.setup();

    const result = await h.callTool({
      tool: "write",
      args: { path: "runs/log.md", content: { $inline: "hello" } },
      renderOnly: true,
    });

    expect(called).toBe(false);
    expect(h.permissionCalls).toEqual([]);
    expect(result.content).toContain('"path": "runs/log.md"');
    expect(result.content).toContain('"content": "hello"');
  });

  it("does not check target permission for renderOnly, even for a denied path", async () => {
    const h = makeHarness();
    usePermissionRules(h, [{ action: "edit", resource: "*", effect: "deny" }]);
    h.addTarget({
      id: "write",
      options: { permission: "edit" },
      execute: async () => ({ content: "ok" }),
    });
    await h.setup();

    const result = await h.callTool({
      tool: "write",
      args: { path: "src/Program.cs", content: "x" },
      renderOnly: true,
    });

    expect(h.permissionCalls).toEqual([]);
    expect(result.content).toContain('"path": "src/Program.cs"');
  });

  it("aborts renderOnly after a template permission check without calling the target", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("task.md", "Task");
    let called = false;
    h.addTarget({
      id: "demo",
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    const controller = new AbortController();
    const assert = h.ctx.permission.assert;
    h.ctx.permission.assert = async (value: any) => {
      await assert(value);
      controller.abort();
    };

    try {
      await h.callTool(
        { tool: "demo", args: { prompt: { $file: "task.md" } }, renderOnly: true },
        makeToolContext({ signal: controller.signal }),
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      expect(called).toBe(false);
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("does not assert target permission when allowedTools rejects the target", async () => {
    const h = makeHarness({ options: { allowedTools: ["other"] } });
    let called = false;
    h.addTarget({
      id: "demo",
      options: { permission: "demo" },
      execute: async () => {
        called = true;
        return { content: "ok" };
      },
    });
    await h.setup();

    await expect(h.callTool({ tool: "demo", args: {} })).rejects.toThrow(/allowedTools/);
    expect(called).toBe(false);
    expect(h.permissionCalls).toEqual([]);
  });

  it("validates target input before executing the target", async () => {
    const h = makeHarness();
    h.addTarget({
      id: "demo",
      input: Schema.Struct({ text: Schema.String }),
    });
    await h.setup();

    await expect(h.callTool({ tool: "demo", args: { text: 42 } })).rejects.toThrow(
      /Invalid arguments for target tool "demo"/,
    );
    expect(h.permissionCalls).toEqual([]);
  });

  it("enforces maxRenderedBytes", async () => {
    const h = makeHarness({ options: { limits: { maxRenderedBytes: 1024 } } });
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expect(
      h.callTool({
        tool: "subagent",
        args: { prompt: "x".repeat(2000) },
      }),
    ).rejects.toThrow(/maxRenderedBytes/);
  });

  it("rejects renderOnly content that exceeds maxRenderedBytes after pretty-printing", async () => {
    const h = makeHarness({ options: { limits: { maxRenderedBytes: 1024 } } });
    h.addTarget({ id: "subagent" });
    await h.setup();
    const args = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `key${String(index).padStart(2, "0")}`,
        "x".repeat(40),
      ]),
    );
    const compactBytes = Buffer.byteLength(JSON.stringify(args), "utf8");
    const prettyBytes = Buffer.byteLength(JSON.stringify(args, null, 2), "utf8");
    expect(compactBytes).toBeLessThanOrEqual(1024);
    expect(prettyBytes).toBeGreaterThan(1024);

    await expect(
      h.callTool({ tool: "subagent", args, renderOnly: true }),
    ).rejects.toThrow(/renderOnly content is .* maxRenderedBytes is 1024/);

    const result = await h.callTool({
      tool: "subagent",
      args: { prompt: "hi" },
      renderOnly: true,
    });
    expect(result.content).toBe(JSON.stringify({ prompt: "hi" }, null, 2));
  });

  it("rejects deep JSON rendered in renderOnly", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();
    const deep = "[".repeat(65) + "]".repeat(65);

    await expectToolFailure(
      h.callTool({
        tool: "subagent",
        args: { payload: { $inline: deep, $type: "json" } },
        renderOnly: true,
      }),
      /maximum depth of 64/,
    );
  });

  it("rejects non-serializable rendered args with a ToolError", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expectToolFailure(
      h.callTool({ tool: "subagent", args: { value: 1n } }),
      /Rendered args for tool "subagent" are not JSON-serializable/,
    );
  });

  it("rejects renderOnly args that fail pretty serialization", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();
    let calls = 0;
    const args = {
      toJSON: () => {
        calls += 1;
        return calls === 1 ? { ok: true } : 1n;
      },
    };

    await expectToolFailure(
      h.callTool({ tool: "subagent", args, renderOnly: true }),
      /Rendered args for tool "subagent" are not JSON-serializable/,
    );
  });

  it("rejects arrays over the cap through template_call", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expectToolFailure(
      h.callTool({
        tool: "subagent",
        args: { values: Array.from({ length: 10_001 }, () => 0) },
      }),
      /maximum is 10000/,
    );
  });

  it("rejects invalid inputs", async () => {
    const h = makeHarness();
    h.addTarget({ id: "subagent" });
    await h.setup();

    await expect(h.callTool({ args: {} })).rejects.toThrow(/tool is required/);
    await expect(h.callTool({ tool: "subagent" })).rejects.toThrow(/args is required/);
    await expect(h.callTool({ tool: "subagent", args: [] })).rejects.toThrow(
      /must be an object/,
    );
    await expect(h.callTool({ tool: "subagent", args: "{bad" })).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(
      h.callTool({ tool: "subagent", args: {}, renderOnly: "true" }),
    ).rejects.toThrow(/renderOnly must be a boolean/);
    await expect(h.callTool({ tool: "bad name", args: {} })).rejects.toThrow(
      /name the target exactly/,
    );
  });

  it("fails setup without ctx.tool.list", async () => {
    const h = makeHarness({ noToolList: true });
    await expect(h.setup()).rejects.toThrow(/ctx\.tool\.list/);
  });

  it("fails setup without ctx.permission.assert", async () => {
    const h = makeHarness({ noPermission: true });
    await expect(h.setup()).rejects.toThrow(/ctx\.permission\.assert/);
  });

  it("disposes the registered tool", async () => {
    const h = makeHarness();
    h.addTarget({ id: "read" });
    await h.setup();
    await h.dispose();

    expect([...h.tools.values()].some((tool) => tool.name === "call")).toBe(false);
    expect([...h.tools.values()].some((tool) => tool.name === "read")).toBe(true);
  });
});
