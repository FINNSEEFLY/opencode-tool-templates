import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import {
  createChainRenderer,
  TEMPLATE_TYPES,
  TEMPLATE_TYPE_LIST,
  TYPE_CONVERTERS,
} from "../src/chain";
import { resolveConfig } from "../src/config";
import { createPermissionGuard } from "../src/permissions";
import { createTemplatePaths } from "../src/paths";
import { HELPER_NAMES } from "../src/render";
import { makeToolContext } from "./context";
import { tempDir, writeTemp } from "./temp";

const captureToolError = async (run: () => Promise<unknown>): Promise<ToolError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("Expected a ToolError");
};

const expectToolError = async (run: () => Promise<unknown>, pattern: RegExp) => {
  expect((await captureToolError(run)).message).toMatch(pattern);
};

const FORBIDDEN_INTERNALS = /\[object Object\]|knownHelpersOnly|could not be found/;
const RAW_LOCATION = / - \d+:\d+/;

const expectCleanDiagnostic = (message: string) => {
  expect(message).not.toMatch(FORBIDDEN_INTERNALS);
  expect(message).not.toMatch(RAW_LOCATION);
  expect(message).not.toContain("line undefined");
};

const expectSingleFailurePrefix = (message: string) => {
  expect(message.match(/failed:/g)).toHaveLength(1);
};

const setupRenderer = async (directory: string, options: Record<string, any> = {}) => {
  const config = resolveConfig(options);
  const paths = await createTemplatePaths({
    config,
    location: { directory, project: { directory } },
  });
  const renderer = createChainRenderer({ config, paths });
  const calls: any[] = [];
  const guard = createPermissionGuard({
    assert: async (input) => {
      calls.push(input);
    },
  });
  const context = { tool: makeToolContext(), guard, budget: { bytes: 0 } };
  return { config, renderer, context, calls, guard };
};

describe("template type registry", () => {
  it("pins the template types", () => {
    expect(TEMPLATE_TYPES).toEqual(["string", "number", "boolean", "json"]);
    expect(TEMPLATE_TYPE_LIST).toBe("string, number, boolean, or json");
  });

  it("converts values with every converter", () => {
    const cases = [
      ["string", "text", "text"],
      ["number", "42", 42],
      ["boolean", "TRUE", true],
      ["json", '{"a":1}', { a: 1 }],
    ] as const;
    for (const [type, value, expected] of cases) {
      expect(TYPE_CONVERTERS[type](value, '"<inline>"')).toEqual(expected);
    }
  });

  it("rejects invalid numeric, boolean, and JSON values", () => {
    expect(() => TYPE_CONVERTERS.number("", '"<inline>"')).toThrow(
      /rendered empty text, which is not a number/,
    );
    expect(() => TYPE_CONVERTERS.number("x", '"<inline>"')).toThrow(/not a number/);
    expect(() => TYPE_CONVERTERS.boolean("x", '"<inline>"')).toThrow(/not a boolean/);
    expect(() => TYPE_CONVERTERS.json("{", '"<inline>"')).toThrow(/invalid JSON/);
  });
});

describe("chain renderer", () => {
  it("keeps plain strings literal", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue("literal {{name}}", { name: "X" }, context),
    ).resolves.toBe("literal {{name}}");
  });

  it("renders an inline template with $params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue(
        { $inline: "Hello {{name}} / {{$params.name}}", $params: { name: "X" } },
        {},
        context,
      ),
    ).resolves.toBe("Hello X / X");
  });

  it("renders a file template", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "task.md", "Hello {{name}}");
    const { renderer, context, calls } = await setupRenderer(directory);

    await expect(
      renderer.renderValue({ $file: "task.md", $params: { name: "X" } }, {}, context),
    ).resolves.toBe("Hello X");
    expect(calls.some((call) => call.action === "read")).toBe(true);
  });

  it("renders a templated file path", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "task-X.md", "Hello {{name}}");
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue(
        { $file: "task-{{id}}.md", $params: { id: "X", name: "Y" } },
        {},
        context,
      ),
    ).resolves.toBe("Hello Y");
  });

  it("renders a templated $file path inside a chain", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "part-X.md", "Hello");
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue(
        {
          $parts: [{ $file: "part-{{id}}.md", $params: { id: "X" } }],
        },
        {},
        context,
      ),
    ).resolves.toBe("Hello");
  });

  it("joins a flat chain with a separator", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "b.md", "{{id}}:{{value}}");
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue(
        {
          $parts: [
            { $inline: "A {{id}}" },
            { $file: "b.md", $params: { value: "B" } },
            { $inline: "C" },
          ],
          $params: { id: "1" },
          $separator: "|",
        },
        {},
        context,
      ),
    ).resolves.toBe("A 1|1:B|C");
  });

  it("lets part params override chain params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue(
        {
          $parts: [{ $inline: "{{name}}", $params: { name: "part" } }],
          $params: { name: "chain" },
        },
        {},
        context,
      ),
    ).resolves.toBe("part");
  });

  it("skips zero-length parts and keeps whitespace-only parts", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);
    const chain = {
      $parts: [{ $inline: "A" }, { $inline: "" }, { $inline: "B" }],
      $separator: "|",
      $skipEmpty: true,
    };

    await expect(renderer.renderValue(chain, {}, context)).resolves.toBe("A|B");
    await expect(
      renderer.renderValue(
        { ...chain, $parts: [{ $inline: "A" }, { $inline: "   " }, { $inline: "B" }] },
        {},
        context,
      ),
    ).resolves.toBe("A|   |B");
    await expect(
      renderer.renderValue({ ...chain, $skipEmpty: false }, {}, context),
    ).resolves.toBe("A||B");
    await expect(
      renderer.renderValue(
        { $parts: [{ $inline: "" }, { $inline: "" }], $separator: "|" },
        {},
        context,
      ),
    ).resolves.toBe("");
  });

  it("converts $type values", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue({ $inline: "42", $type: "number" }, {}, context),
    ).resolves.toBe(42);
    await expect(
      renderer.renderValue({ $inline: "0", $type: "number" }, {}, context),
    ).resolves.toBe(0);
    await expect(
      renderer.renderValue({ $inline: "0.0", $type: "number" }, {}, context),
    ).resolves.toBe(0);
    await expect(
      renderer.renderValue({ $inline: "-1", $type: "number" }, {}, context),
    ).resolves.toBe(-1);
    await expect(
      renderer.renderValue({ $inline: "TRUE", $type: "boolean" }, {}, context),
    ).resolves.toBe(true);
    await expect(
      renderer.renderValue({ $inline: '{"a":1}', $type: "json" }, {}, context),
    ).resolves.toEqual({ a: 1 });
  });

  it("applies $type to the final chain output", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue(
        { $parts: [{ $inline: "4" }, { $inline: "2" }], $separator: "", $type: "number" },
        {},
        context,
      ),
    ).resolves.toBe(42);
  });

  it("rejects empty renders for $type number", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () => renderer.renderValue({ $inline: "", $type: "number" }, {}, context),
      /rendered empty text, which is not a number/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: " \n\t ", $type: "number" }, {}, context),
      /rendered empty text, which is not a number/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          { $inline: "{{#if missing}}x{{/if}}", $type: "number" },
          {},
          context,
        ),
      /rendered empty text, which is not a number/,
    );
  });

  it("rejects invalid $type conversions", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $type: "number" }, {}, context),
      /not a number/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $type: "boolean" }, {}, context),
      /not a boolean/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "{", $type: "json" }, {}, context),
      /invalid JSON/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $type: "date" }, {}, context),
      /^\$type must be "string", "number", "boolean", or "json"\.$/,
    );
  });

  it("rejects invalid template objects", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () => renderer.renderValue({ $params: {} }, {}, context),
      /must be inside a template object/,
    );
    await expectToolError(
      () => renderer.renderValue({ $type: "string" }, {}, context),
      /require a source/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $file: "x.md" }, {}, context),
      /^Use exactly one of \$inline, \$file, or \$parts\.$/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $foo: 1 }, {}, context),
      /unsupported key/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", extra: 1 }, {}, context),
      /unsupported key/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $separator: "|" }, {}, context),
      /only valid on a \$parts chain/,
    );
  });

  it("requires other modifier keys to have a source", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    for (const [key, value] of [
      ["$type", "string"],
      ["$separator", "|"],
      ["$skipEmpty", true],
    ] as const) {
      await expectToolError(
        () => renderer.renderValue({ [key]: value }, {}, context),
        /^Template modifiers \(\$type, \$separator, \$skipEmpty\) require a source\.$/,
      );
    }
  });

  it("explains top-level $params placement for args", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderArgs({ prompt: "hi", $params: { name: "X" } }, context),
    );

    expect(error.message).toBe(
      '$params must be inside a template object, for example {"$inline":"...","$params":{...}}. ' +
        'To share values across args, use the params input. Use $type:"json" to pass reserved keys as target arguments.',
    );
  });

  it("renders args with shared params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const result = await renderer.renderArgs(
      {
        prompt: {
          $inline: "{{project}}/{{name}}",
          $params: { name: "task" },
        },
      },
      context,
      { project: "billing" },
    );

    expect(JSON.parse(JSON.stringify(result))).toEqual({ prompt: "billing/task" });
  });

  it("keeps the top-level $params hint context-neutral for templates", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderTemplateValue({ $params: { name: "X" } }, context),
    );

    expect(error.message).toBe(
      '$params must be inside a template object, for example {"$inline":"...","$params":{...}}.',
    );
  });

  it("labels $type errors by source kind", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "task.md", "x");
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $type: "number" }, {}, context),
      /^Template "<inline>" rendered "x", which is not a number\.$/,
    );
    await expectToolError(
      () => renderer.renderValue({ $file: "task.md", $type: "number" }, {}, context),
      /^Template "task.md" rendered "x", which is not a number\.$/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          { $parts: [{ $inline: "x" }], $type: "number" },
          {},
          context,
        ),
      /^Template "<parts>" rendered "x", which is not a number\.$/,
    );
  });

  it("rejects unsupported template objects and preserves ordinary objects", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () =>
        renderer.renderValue(
          { $parts: [{ $inline: "x" }], $previous: "old" },
          {},
          context,
        ),
      /unsupported key/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: 42 }, {}, context),
      /must be a string/,
    );
    await expectToolError(
      () => renderer.renderValue({ $file: 42 }, {}, context),
      /must be a string/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $params: [] }, {}, context),
      /must be an object/,
    );
    await expect(renderer.renderValue({ $unknown: 1 }, {}, context)).resolves.toEqual({
      $unknown: 1,
    });
  });

  it("rejects invalid $parts chains", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () => renderer.renderValue({ $parts: [] }, {}, context),
      /non-empty array/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: ["x"] }, {}, context),
      /must be an object/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: "x" }, {}, context),
      /non-empty array/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: [{ $inline: "x", $file: "y" }] }, {}, context),
      /exactly one/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: [{ $params: {} }] }, {}, context),
      /exactly one/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: [{ $parts: [] }] }, {}, context),
      /nested \$parts/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          { $parts: [{ $inline: "x", $type: "string" }] },
          {},
          context,
        ),
      /unsupported key/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          { $parts: [{ $inline: "x", $separator: "|" }] },
          {},
          context,
        ),
      /unsupported key/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          { $parts: [{ $inline: "x" }], $skipEmpty: "true" },
          {},
          context,
        ),
      /^\$skipEmpty must be a boolean\.$/,
    );
    await expectToolError(
      () =>
        renderer.renderValue({ $parts: [{ $inline: "x" }], $separator: 1 }, {}, context),
      /must be a string/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: [{ $inline: 42 }] }, {}, context),
      /^\$parts\[0\]\.\$inline must be a string\.$/,
    );
    await expectToolError(
      () => renderer.renderValue({ $parts: [{ $file: 42 }] }, {}, context),
      /^\$parts\[0\]\.\$file must be a string\.$/,
    );
  });

  it("rejects sparse $parts arrays", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);
    const sparse: unknown[] = [];
    sparse.length = 2;

    await expectToolError(
      () => renderer.renderValue({ $parts: sparse }, {}, context),
      /^\$parts\[0\] must be an object with \$inline or \$file\.$/,
    );
  });

  it("rejects non-object part-level $params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    for (const params of [null, [], "x", 42]) {
      await expectToolError(
        () =>
          renderer.renderValue(
            { $parts: [{ $inline: "x", $params: params }] },
            {},
            context,
          ),
        /^\$parts\[0\]\.\$params must be an object\.$/,
      );
    }
  });

  it("enforces maxChainParts", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory, {
      limits: { maxChainParts: 1 },
    });

    await expectToolError(
      () =>
        renderer.renderValue(
          { $parts: [{ $inline: "a" }, { $inline: "b" }] },
          {},
          context,
        ),
      /maxChainParts/,
    );
  });

  it("rejects oversized inline templates before compiling", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory, {
      limits: { maxTemplateBytes: 1024 },
    });

    await expectToolError(
      () => renderer.renderValue({ $inline: "{{#if}}".repeat(200) }, {}, context),
      /maxTemplateBytes/,
    );
  });

  it("rejects oversized args JSON strings before parsing", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory, {
      limits: { maxRenderedBytes: 1024 },
    });

    await expectToolError(
      () => renderer.renderArgs(`{bad${"x".repeat(2000)}`, context),
      /maxRenderedBytes/,
    );
    await expectToolError(
      () => renderer.renderArgs(JSON.stringify({ prompt: "x".repeat(2000) }), context),
      /maxRenderedBytes/,
    );
  });

  it("rejects oversized or non-serializable $params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory, {
      limits: { maxRenderedBytes: 1024 },
    });

    await expectToolError(
      () =>
        renderer.renderValue(
          { $inline: "x", $params: { value: "x".repeat(2000) } },
          {},
          context,
        ),
      /\$params is \d+ bytes; maxRenderedBytes is 1024/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          {
            $parts: [{ $inline: "x", $params: { value: "x".repeat(2000) } }],
          },
          {},
          context,
        ),
      /Chain part 1 \(<inline>\) failed: \$params is .* maxRenderedBytes/,
    );
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $params: { big: 1n } }, {}, context),
      /\$params must be JSON-serializable/,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expectToolError(
      () => renderer.renderValue({ $inline: "x", $params: circular }, {}, context),
      /\$params must be JSON-serializable/,
    );
    await expectToolError(
      () =>
        renderer.renderValue(
          {
            $inline: "x",
            $params: { toJSON: () => undefined, value: "x".repeat(2000) },
          },
          {},
          context,
        ),
      /\$params must be JSON-serializable/,
    );
  });

  it("caps args nesting depth and array size", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const atLimit = Array.from({ length: 64 }).reduce<unknown>((value) => [value], "x");
    await expect(renderer.renderValue(atLimit, {}, context)).resolves.toBeDefined();

    const tooDeep = Array.from({ length: 65 }).reduce<unknown>((value) => [value], "x");
    await expectToolError(
      () => renderer.renderValue(tooDeep, {}, context),
      /maximum depth of 64/,
    );

    const atArrayLimit = Array.from({ length: 10_000 }, (_, index) => index);
    const allowed = await renderer.renderValue({ values: atArrayLimit }, {}, context);
    expect((allowed as { values: unknown[] }).values).toHaveLength(10_000);

    const tooWide = Array.from({ length: 10_001 }, (_, index) => index);
    await expectToolError(
      () => renderer.renderValue({ values: tooWide }, {}, context),
      /maximum is 10000/,
    );
  });

  it("enforces value caps on $type json results", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const deep = "[".repeat(65) + "]".repeat(65);
    await expectToolError(
      () => renderer.renderValue({ $inline: deep, $type: "json" }, {}, context),
      /maximum depth of 64/,
    );

    const wide = JSON.stringify(Array.from({ length: 10_001 }, () => 0));
    await expectToolError(
      () => renderer.renderValue({ $inline: wide, $type: "json" }, {}, context),
      /maximum is 10000/,
    );

    const atLimit = JSON.stringify(Array.from({ length: 10_000 }, () => 0));
    await expect(
      renderer.renderValue({ $inline: atLimit, $type: "json" }, {}, context),
    ).resolves.toHaveLength(10_000);

    const huge = "[".repeat(50_000) + "]".repeat(50_000);
    await expectToolError(
      () => renderer.renderValue({ $inline: huge, $type: "json" }, {}, context),
      /maximum depth of 64|invalid JSON/,
    );

    await expect(
      renderer.renderValue(
        { $inline: '{"nested":{"list":[1,2,3]}}', $type: "json" },
        {},
        context,
      ),
    ).resolves.toEqual({ nested: { list: [1, 2, 3] } });
  });

  it("renders normal nested objects and arrays", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const result = await renderer.renderValue(
      {
        nested: {
          list: [1, { $inline: "{{name}}", $params: { name: "X" } }],
        },
      },
      {},
      context,
    );

    expect(result).toEqual({ nested: { list: [1, "X"] } });
  });

  it("renders args objects, JSON strings, and whole-args template objects", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);
    const ref = { $inline: "Hi {{name}}", $params: { name: "X" } };

    const fromObject = await renderer.renderArgs({ prompt: ref }, context);
    expect(JSON.parse(JSON.stringify(fromObject))).toEqual({ prompt: "Hi X" });

    const fromString = await renderer.renderArgs(
      JSON.stringify({ prompt: ref }),
      context,
    );
    expect(JSON.parse(JSON.stringify(fromString))).toEqual({ prompt: "Hi X" });

    const fromWhole = await renderer.renderArgs(
      {
        $inline: '{"agent":"general","prompt":"{{prompt}}"}',
        $type: "json",
        $params: { prompt: "Hello" },
      },
      context,
    );
    expect(JSON.parse(JSON.stringify(fromWhole))).toEqual({
      agent: "general",
      prompt: "Hello",
    });
  });

  it("defaults a stringified whole-args template object to json", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const result = await renderer.renderArgs(
      JSON.stringify({ $inline: '{"agent":"general"}', $params: {} }),
      context,
    );

    expect(JSON.parse(JSON.stringify(result))).toEqual({ agent: "general" });
  });

  it("uses the configured default separator and skip-empty", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory, {
      defaultSeparator: "|",
      defaultSkipEmpty: false,
    });

    await expect(
      renderer.renderValue(
        { $parts: [{ $inline: "A" }, { $inline: "" }, { $inline: "B" }] },
        {},
        context,
      ),
    ).resolves.toBe("A||B");
  });

  it("returns an empty string when every part is empty", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expect(
      renderer.renderValue({ $parts: [{ $inline: "" }, { $inline: "" }] }, {}, context),
    ).resolves.toBe("");
  });

  it("enforces maxRenderedBytes while rendering a chain", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory, {
      limits: { maxRenderedBytes: 1024 },
    });

    await expectToolError(
      () =>
        renderer.renderValue(
          {
            $parts: [{ $inline: "x".repeat(600) }, { $inline: "y".repeat(600) }],
            $separator: "",
          },
          {},
          context,
        ),
      /maxRenderedBytes/,
    );
  });

  it("does not pollute prototypes through $params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);
    const params = JSON.parse('{"__proto__":{"polluted":true},"name":"X"}');

    await expect(
      renderer.renderValue({ $inline: "{{name}}", $params: params }, {}, context),
    ).resolves.toBe("X");
    expect(({} as any).polluted).toBeUndefined();
  });

  it("ignores inherited $params on template objects and parts", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const ref = Object.assign(Object.create({ $params: { name: "inherited" } }), {
      $inline: "{{name}}",
    });
    await expect(renderer.renderValue(ref, { name: "own" }, context)).resolves.toBe(
      "own",
    );

    const part = Object.assign(Object.create({ $params: { name: "inherited" } }), {
      $inline: "{{name}}",
    });
    const chain = { $parts: [part], $params: { name: "own" } };
    await expect(renderer.renderValue(chain, {}, context)).resolves.toBe("own");
  });

  it("rejects invalid args", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(() => renderer.renderArgs([], context), /must be an object/);
    await expectToolError(() => renderer.renderArgs("{bad", context), /not valid JSON/);
    await expectToolError(
      () => renderer.renderArgs({ $inline: "x", $type: "string" }, context),
      /must render to a JSON object/,
    );
  });

  it("rejects JSON string arrays and primitives as args", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    for (const rawArgs of ["[]", "[1,2]", "42", '"text"', "null", "true"]) {
      await expectToolError(
        () => renderer.renderArgs(rawArgs, context),
        /^args must be a JSON object\.$/,
      );
    }
  });

  it("renders template_build objects and returns parts/params", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const result = await renderer.renderTemplateValue(
      {
        $parts: [{ $inline: "A" }, { $inline: "B" }],
        $separator: "|",
        $params: { id: "X" },
      },
      context,
    );

    expect(result.text).toBe("A|B");
    expect(result.parts).toBe(2);
    expect(result.params.id).toBe("X");
  });

  it("counts one part for inline and file template_build objects", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "task.md", "File");
    const { renderer, context } = await setupRenderer(directory);

    const inline = await renderer.renderTemplateValue({ $inline: "Inline" }, context);
    expect(inline.parts).toBe(1);

    const file = await renderer.renderTemplateValue({ $file: "task.md" }, context);
    expect(file.parts).toBe(1);
  });

  it("rejects plain strings and $type for template_build", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    await expectToolError(
      () => renderer.renderTemplateValue("plain", context),
      /template must be a template object/,
    );
    await expectToolError(
      () => renderer.renderTemplateValue({ $inline: "42", $type: "number" }, context),
      /Only \$type: "string" is supported/,
    );
    await expect(
      renderer.renderTemplateValue({ $inline: "42", $type: "string" }, context),
    ).resolves.toMatchObject({ text: "42" });
  });

  it("does not rescan JSON produced by $type", async () => {
    const directory = await tempDir();
    const { renderer, context, calls } = await setupRenderer(directory);

    const result = await renderer.renderValue(
      { $inline: '{"$file":"secret.md"}', $type: "json" },
      {},
      context,
    );

    expect(result).toEqual({ $file: "secret.md" });
    expect(calls).toEqual([]);
  });

  it("propagates an abort from a $parts file part", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "part.md", "Hello");
    const { renderer, context } = await setupRenderer(directory);
    const controller = new AbortController();
    const reason = new Error("stopped");
    reason.name = "AbortError";
    controller.abort(reason);
    context.tool = makeToolContext({ signal: controller.signal });

    try {
      await renderer.renderValue({ $parts: [{ $file: "part.md" }] }, {}, context);
    } catch (error) {
      expect(error).toBe(reason);
      expect((error as Error).name).toBe("AbortError");
      expect(error).not.toBeInstanceOf(ToolError);
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("wraps non-abort $parts errors with the part index", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue(
        { $parts: [{ $inline: "A" }, { $file: "missing.md" }] },
        {},
        context,
      ),
    );
    expect(error.message).toMatch(
      /^Chain part 2 \(missing\.md\) failed: Template path "missing\.md" is not allowed by templatePaths or was not found\.$/,
    );
    expectSingleFailurePrefix(error.message);
    expectCleanDiagnostic(error.message);
  });

  it("preserves metadata when wrapping a $parts error", async () => {
    const failure = new ToolError({ message: "boom", metadata: { code: "E_PART" } });
    const renderer = createChainRenderer({
      config: resolveConfig({}),
      paths: {
        matchesTemplatePath: () => true,
        readTemplate: async () => {
          throw failure;
        },
        writeTemplate: async () => {
          throw new Error("unused");
        },
      },
    });
    const guard = createPermissionGuard({ assert: async () => {} });
    const context = { tool: makeToolContext(), guard, budget: { bytes: 0 } };

    try {
      await renderer.renderValue({ $parts: [{ $file: "part.md" }] }, {}, context);
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as Error).message).toMatch(/Chain part 1 \(part\.md\) failed: boom/);
      expect((error as { metadata?: unknown }).metadata).toEqual({ code: "E_PART" });
      return;
    }
    throw new Error("Expected a rejection");
  });
});

describe("render diagnostics", () => {
  it("normalizes a missing variable in an inline template", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue({ $inline: "Hello\n{{name}}" }, {}, context),
    );

    expect(error.message).toBe(
      'Template "<inline>" failed: "name" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.name}} if the name collides with a helper.',
    );
    expectCleanDiagnostic(error.message);
  });

  it("normalizes a missing variable in a file template", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "prompts/sleep-task.md", "Sleep\nTask {{TASK_ID}}");
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue({ $file: "prompts/sleep-task.md" }, {}, context),
    );

    expect(error.message).toBe(
      'Template "prompts/sleep-task.md" failed: "TASK_ID" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.TASK_ID}} if the name collides with a helper.',
    );
    expectCleanDiagnostic(error.message);
  });

  it("reports a missing variable in a $parts part exactly once", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue(
        {
          $parts: [{ $inline: "A" }, { $inline: "Rules\nProject {{project}}" }],
        },
        {},
        context,
      ),
    );

    expect(error.message).toBe(
      'Chain part 2 (<inline>) failed: "project" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.project}} if the name collides with a helper.',
    );
    expectSingleFailurePrefix(error.message);
    expectCleanDiagnostic(error.message);
  });

  it("uses the rendered $file path in a chain part label", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "part-X.md", "Rules\nProject {{project}}");
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue(
        {
          $parts: [{ $inline: "A" }, { $file: "part-{{id}}.md", $params: { id: "X" } }],
        },
        {},
        context,
      ),
    );

    expect(error.message).toBe(
      'Chain part 2 (part-X.md) failed: "project" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.project}} if the name collides with a helper.',
    );
    expectSingleFailurePrefix(error.message);
    expectCleanDiagnostic(error.message);
  });

  it("falls back to the raw $file value when the path template fails", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue({ $parts: [{ $file: "part-{{id}}.md" }] }, {}, context),
    );

    expect(error.message).toBe(
      'Chain part 1 (part-{{id}}.md) failed: "id" is not defined (line 1). If it is a parameter, pass it in $params; use {{$params.id}} if the name collides with a helper.',
    );
    expectSingleFailurePrefix(error.message);
    expectCleanDiagnostic(error.message);
  });

  it("normalizes an unknown helper in a chain part", async () => {
    const directory = await tempDir();
    const { renderer, context } = await setupRenderer(directory);

    const error = await captureToolError(() =>
      renderer.renderValue({ $parts: [{ $inline: "{{bogus 1}}" }] }, {}, context),
    );

    expect(error.message).toBe(
      `Chain part 1 (<inline>) failed: Unknown helper "bogus" (line 1). Allowed helpers: ${HELPER_NAMES.join(", ")}.`,
    );
    expectSingleFailurePrefix(error.message);
    expectCleanDiagnostic(error.message);
  });
});
