import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "./context";
import { makeHarness } from "./harness";
import { tempDir } from "./temp";

const slash = (value: string) => value.replaceAll("\\", "/");

const captureToolFailure = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
  throw new Error("Expected a rejection");
};

describe("template_build", () => {
  it("returns assembled text without path", async () => {
    const h = makeHarness();
    await h.setup();

    const result = await h.callBuild({
      template: {
        $parts: [{ $inline: "A" }, { $inline: "B" }],
        $separator: "|",
      },
    });

    expect(result.content).toBe("A|B");
    expect(result.output).toEqual({ text: "A|B", bytes: 3, parts: 2 });
  });

  it("writes a file without returning the text", async () => {
    const h = makeHarness();
    await h.setup();

    const result = await h.callBuild({
      template: { $inline: "Hello {{name}}", $params: { name: "X" } },
      path: "build/{{name}}.txt",
    });

    expect(result.content).toMatch(/^Wrote build\/X\.txt \(\d+ bytes, 1 part\)\.$/);
    expect(result.output).toEqual({
      path: "build/X.txt",
      bytes: 7,
      parts: 1,
    });
    expect(await readFile(join(h.directory, "build/X.txt"), "utf8")).toBe("Hello X");
    expect(
      h.permissionCalls.some(
        (call) => call.action === "edit" && call.resources.includes("build/X.txt"),
      ),
    ).toBe(true);
  });

  it("reads a file template", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("templates/task.md", "Hello {{name}}");

    const result = await h.callBuild({
      template: {
        $file: "templates/task.md",
        $params: { name: "X" },
      },
    });

    expect(result.content).toBe("Hello X");
  });

  it("normalizes a missing variable in a $parts template", async () => {
    const h = makeHarness();
    await h.setup();

    const error = await captureToolFailure(
      h.callBuild({
        template: {
          $parts: [{ $inline: "A" }, { $inline: "Rules\nProject {{project}}" }],
        },
      }),
    );

    expect(error.message).toBe(
      'Chain part 2 (<inline>) failed: "project" is not defined (line 2). If it is a parameter, pass it in $params; use {{$params.project}} if the name collides with a helper.',
    );
    expect(error.message.match(/failed:/g)).toHaveLength(1);
  });

  it("explains top-level $params placement without args guidance", async () => {
    const h = makeHarness();
    await h.setup();

    const error = await captureToolFailure(
      h.callBuild({ template: { $params: { name: "X" } } }),
    );

    expect(error.message).toBe(
      '$params must be inside a template object, for example {"$inline":"...","$params":{...}}.',
    );
  });

  it("refuses to overwrite unless asked", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("build/a.txt", "old");

    await expect(
      h.callBuild({ template: { $inline: "new" }, path: "build/a.txt" }),
    ).rejects.toThrow(/already exists/);

    const result = await h.callBuild({
      template: { $inline: "new" },
      path: "build/a.txt",
      overwrite: true,
    });
    expect(result.output.path).toBe("build/a.txt");
    expect(await readFile(join(h.directory, "build/a.txt"), "utf8")).toBe("new");
  });

  it("ignores an inherited path", async () => {
    const h = makeHarness();
    await h.setup();
    const input = Object.assign(Object.create({ path: "build/inherited.txt" }), {
      template: { $inline: "x" },
    });

    const result = await h.callBuild(input);

    expect(result.output).toEqual({ text: "x", bytes: 1, parts: 1 });
    await expect(
      readFile(join(h.directory, "build/inherited.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("ignores an inherited overwrite", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("build/a.txt", "old");
    const input = Object.assign(Object.create({ overwrite: true }), {
      template: { $inline: "new" },
      path: "build/a.txt",
    });

    await expect(h.callBuild(input)).rejects.toThrow(/already exists/);
    expect(await readFile(join(h.directory, "build/a.txt"), "utf8")).toBe("old");
  });

  it("rejects overwrite without path", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(
      h.callBuild({ template: { $inline: "x" }, overwrite: true }),
    ).rejects.toThrow(/only valid with path/);
  });

  it("rejects a plain string template and $type", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(h.callBuild({ template: "x" })).rejects.toThrow(
      /template must be a template object/,
    );
    await expect(
      h.callBuild({ template: { $inline: "42", $type: "number" } }),
    ).rejects.toThrow(/Only \$type: "string" is supported/);
    await expect(
      h.callBuild({ template: { $inline: "42", $type: "string" } }),
    ).resolves.toMatchObject({ content: "42" });
  });

  it("rejects missing, null, and non-object templates", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(h.callBuild({})).rejects.toThrow(/^template is required\.$/);
    for (const template of [null, undefined, [], ["x"], 42, true]) {
      await expect(h.callBuild({ template })).rejects.toThrow(
        /^template must be a template object: /,
      );
    }
  });

  it("rejects a NUL byte in a rendered $file path", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(
      h.callBuild({
        template: { $file: "templates/{{name}}.md", $params: { name: "a\0b" } },
      }),
    ).rejects.toThrow(/^Template path contains a NUL byte\.$/);
  });

  it("rejects non-object $params on a template object", async () => {
    const h = makeHarness();
    await h.setup();

    for (const params of [null, [], "x", 42]) {
      await expect(
        h.callBuild({ template: { $inline: "x", $params: params } }),
      ).rejects.toThrow(/^\$params must be an object\.$/);
    }
  });

  it("enforces buildPaths", async () => {
    const h = makeHarness({ options: { buildPaths: ["allowed/**/*"] } });
    await h.setup();

    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "other/a.txt" }),
    ).rejects.toThrow(/not allowed by buildPaths/);
  });

  it("disables file output when buildPaths is empty", async () => {
    const h = makeHarness({ options: { buildPaths: [] } });
    await h.setup();

    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "a.txt" }),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects path traversal", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "../outside.txt" }),
    ).rejects.toThrow(/not allowed by buildPaths/);
  });

  it("uses object-level params for the output path", async () => {
    const h = makeHarness();
    await h.setup();

    const result = await h.callBuild({
      template: {
        $parts: [{ $inline: "x", $params: { id: "part" } }],
        $params: { id: "chain" },
      },
      path: "build/{{id}}.txt",
    });

    expect(result.output.path).toBe("build/chain.txt");
  });

  it("writes outside the project when buildPaths allows it", async () => {
    const external = await tempDir();
    const realExternal = await realpath(external);
    const h = makeHarness({
      options: { buildPaths: ["**/*", slash(join(realExternal, "**/*"))] },
    });
    await h.setup();

    const result = await h.callBuild({
      template: { $inline: "x" },
      path: join(realExternal, "out.txt"),
    });

    expect(result.output.path).toBe(slash(join(realExternal, "out.txt")));
    const actions = h.permissionCalls.map((call) => call.action);
    expect(actions).toContain("external_directory");
    expect(actions).toContain("edit");
    const externalCall = h.permissionCalls.find(
      (call) => call.action === "external_directory",
    );
    expect(externalCall.resources).toEqual([slash(join(realExternal, "*"))]);
    expect(externalCall.save).toEqual([slash(join(await realpath(h.directory), "*"))]);
    const editCall = h.permissionCalls.find((call) => call.action === "edit");
    expect(editCall.resources).toEqual([slash(join(realExternal, "out.txt"))]);
    expect(editCall.save).toEqual(["*"]);
  });

  it("rejects empty, directory, and invalid paths", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("build/dir/file.txt", "x");

    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "   " }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "build/dir" }),
    ).rejects.toThrow(/is a directory/);
    await expect(h.callBuild({ template: { $inline: "x" }, path: 42 })).rejects.toThrow(
      /path must be a string/,
    );
    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "a.txt", overwrite: "true" }),
    ).rejects.toThrow(/overwrite must be a boolean/);
  });

  it("enforces maxRenderedBytes", async () => {
    const h = makeHarness({ options: { limits: { maxRenderedBytes: 1024 } } });
    await h.setup();

    await expect(
      h.callBuild({ template: { $inline: "x".repeat(2000) } }),
    ).rejects.toThrow(/maxRenderedBytes/);
  });

  it("rejects NUL and paths that render empty", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "a\0b" }),
    ).rejects.toThrow(/NUL/);
    await expect(
      h.callBuild({
        template: { $inline: "x", $params: { value: "a\0b" } },
        path: "{{value}}",
      }),
    ).rejects.toThrow(/NUL/);
    await expect(
      h.callBuild({
        template: { $inline: "x", $params: { value: "" } },
        path: "{{value}}",
      }),
    ).rejects.toThrow(/empty after rendering/);
    await expect(
      h.callBuild({
        template: { $inline: "x", $params: { value: "   " } },
        path: "{{value}}",
      }),
    ).rejects.toThrow(/empty after rendering/);
  });

  it("applies buildPaths to a path rendered from params", async () => {
    const h = makeHarness();
    await h.setup();

    await expect(
      h.callBuild({
        template: { $inline: "x", $params: { id: "../../outside" } },
        path: "build/{{id}}.txt",
      }),
    ).rejects.toThrow(/not allowed by buildPaths/);
  });

  it("reports UTF-8 byte length rather than string length", async () => {
    const h = makeHarness();
    await h.setup();

    const result = await h.callBuild({ template: { $inline: "é" } });
    expect(result.content).toBe("é");
    expect(result.output.bytes).toBe(2);
  });

  it("renders a templated $file path", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("templates/task-X.md", "Hello");

    const result = await h.callBuild({
      template: {
        $file: "templates/task-{{id}}.md",
        $params: { id: "X" },
      },
    });

    expect(result.content).toBe("Hello");
  });

  it("checks read permission for file templates", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("templates/task.md", "Hello");

    await h.callBuild({ template: { $file: "templates/task.md" } });

    expect(h.permissionCalls.some((call) => call.action === "read")).toBe(true);
  });

  it("propagates read and edit permission denials", async () => {
    const h = makeHarness();
    await h.setup();
    await h.write("templates/task.md", "Hello");
    h.setPermissionError(new ToolError({ message: "denied" }));

    await expect(
      h.callBuild({ template: { $file: "templates/task.md" } }),
    ).rejects.toThrow(/denied/);
    await expect(
      h.callBuild({ template: { $inline: "x" }, path: "a.txt" }),
    ).rejects.toThrow(/denied/);
  });

  it("enforces maxRenderedBytes on the rendered output path", async () => {
    const h = makeHarness({ options: { limits: { maxRenderedBytes: 1024 } } });
    await h.setup();

    await expect(
      h.callBuild({
        template: { $inline: "x", $params: { big: "x".repeat(2000) } },
        path: "{{big}}",
      }),
    ).rejects.toThrow(/maxRenderedBytes/);
  });

  it("propagates an abort instead of wrapping it", async () => {
    const h = makeHarness();
    await h.setup();
    const controller = new AbortController();
    controller.abort();

    try {
      await h.callBuild(
        { template: { $inline: "x" }, path: "a.txt" },
        makeToolContext({ signal: controller.signal }),
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("rejects text mode before returning when the signal is already aborted", async () => {
    const h = makeHarness();
    await h.setup();
    const controller = new AbortController();
    controller.abort();

    try {
      await h.callBuild(
        { template: { $inline: "x" } },
        makeToolContext({ signal: controller.signal }),
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      return;
    }
    throw new Error("Expected a rejection");
  });
});
