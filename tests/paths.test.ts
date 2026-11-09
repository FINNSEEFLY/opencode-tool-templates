import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  link,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { resolveConfig } from "../src/config";
import { createPermissionGuard } from "../src/permissions";
import { createTemplatePaths, redactPath } from "../src/paths";
import { makeToolContext } from "./context";
import { tempDir, writeTemp } from "./temp";

const slash = (value: string) => value.replaceAll("\\", "/");

const canCreateSymlink = (kind: "file" | "dir") => {
  const directory = mkdtempSync(join(tmpdir(), "tool-templates-symlink-"));
  try {
    const target = join(directory, "target");
    if (kind === "file") writeFileSync(target, "");
    else mkdirSync(target);
    const type = process.platform === "win32" && kind === "dir" ? "junction" : kind;
    symlinkSync(target, join(directory, "link"), type);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const canCreateFileSymlink = canCreateSymlink("file");
const canCreateDirectorySymlink = canCreateSymlink("dir");

const canCreateHardLink = (() => {
  const directory = mkdtempSync(join(tmpdir(), "tool-templates-link-"));
  try {
    const target = join(directory, "target");
    writeFileSync(target, "");
    linkSync(target, join(directory, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

const canCreateFifo = (() => {
  if (process.platform === "win32") return false;
  const directory = mkdtempSync(join(tmpdir(), "tool-templates-fifo-"));
  try {
    execFileSync("mkfifo", [join(directory, "pipe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

const captureError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a rejection");
};

const setupPaths = async (
  directory: string,
  options: Record<string, any> = {},
  projectDirectory = directory,
) => {
  const config = resolveConfig(options);
  const paths = await createTemplatePaths({
    config,
    location: { directory, project: { directory: projectDirectory } },
  });
  const calls: any[] = [];
  const guard = createPermissionGuard({
    assert: async (input) => {
      calls.push(input);
    },
  });
  return { config, paths, calls, guard };
};

describe("template paths", () => {
  it("reads a file inside the project and checks read permission", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "templates/task.md", "Hello");
    const { paths, calls, guard } = await setupPaths(directory);

    const result = await paths.readTemplate(
      "templates/task.md",
      makeToolContext(),
      guard,
    );

    expect(result.text).toBe("Hello");
    expect(result.resource).toBe("templates/task.md");
    expect(calls.map((call) => call.action)).toEqual(["read"]);
    expect(calls[0].resources).toEqual(["templates/task.md"]);
  });

  it("includes session and tool-call identity in permission requests", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths, calls, guard } = await setupPaths(directory);

    await paths.readTemplate("a.md", makeToolContext(), guard);
    await paths.writeTemplate("build/a.txt", "x", makeToolContext(), guard, {
      overwrite: false,
    });

    expect(calls).toEqual([
      {
        sessionID: "ses_test",
        agent: "build",
        source: { type: "tool", messageID: "msg_test", id: "call_test" },
        action: "read",
        resources: ["a.md"],
        save: ["*"],
      },
      {
        sessionID: "ses_test",
        agent: "build",
        source: { type: "tool", messageID: "msg_test", id: "call_test" },
        action: "edit",
        resources: ["build/a.txt"],
        save: ["*"],
      },
    ]);
  });

  it("accepts an absolute path inside the project", async () => {
    const directory = await tempDir();
    const file = await writeTemp(directory, "templates/task.md", "Hello");
    const { paths, guard } = await setupPaths(directory);

    const result = await paths.readTemplate(file, makeToolContext(), guard);
    expect(result.text).toBe("Hello");
  });

  it("rejects a path outside templatePaths", async () => {
    const directory = await tempDir();
    const outside = await tempDir();
    const file = await writeTemp(outside, "outside.md", "secret");
    const { paths, calls, guard } = await setupPaths(directory);

    await expect(paths.readTemplate(file, makeToolContext(), guard)).rejects.toThrow(
      /not allowed by templatePaths or was not found/,
    );
    expect(calls).toEqual([]);
  });

  it("does not reveal whether an outside path exists", async () => {
    const directory = await tempDir();
    const outside = await tempDir();
    const file = await writeTemp(outside, "outside.md", "secret");
    const label = relative(directory, file);
    const { paths, guard } = await setupPaths(directory);

    const existing = await captureError(
      paths.readTemplate(label, makeToolContext(), guard),
    );
    await rm(file);
    const missing = await captureError(
      paths.readTemplate(label, makeToolContext(), guard),
    );

    const expected = `Template path "${label}" is not allowed by templatePaths or was not found.`;
    expect(existing.message).toBe(expected);
    expect(missing.message).toBe(expected);
    expect(existing.message).not.toContain(slash(directory));
    expect(existing.message).not.toContain("**/*");
    expect(existing.message).not.toContain("Allowed patterns");
  });

  it("does not echo allowlist patterns or resolved paths", async () => {
    const directory = await tempDir();
    const outside = await tempDir();
    const file = await writeTemp(outside, "secret.md", "secret");
    const label = relative(directory, file);
    const { paths, guard } = await setupPaths(directory, {
      templatePaths: ["templates/**/*"],
    });

    const error = await captureError(paths.readTemplate(label, makeToolContext(), guard));

    expect(error.message).toBe(
      `Template path "${label}" is not allowed by templatePaths or was not found.`,
    );
    expect(error.message).not.toContain(slash(directory));
    expect(error.message).not.toContain(slash(file));
    expect(error.message).not.toContain("templates/**/*");
    expect(error.message).not.toContain("Allowed patterns");
  });

  it("does not expand replacement patterns in display paths", () => {
    const absolute = "C:/project/secret.md";
    const message = `EIO: i/o error, open '${absolute}'`;

    for (const displayPath of ["$&/child.md", "$`/child.md", "$'/child.md"]) {
      const redacted = redactPath(message, absolute, displayPath);
      expect(redacted).toBe(`EIO: i/o error, open '${displayPath}'`);
      expect(redacted).not.toContain(absolute);
    }
  });

  it("uses the uniform message when a parent component is not a directory", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "$&", "not a directory");
    const { paths, guard } = await setupPaths(directory);
    const label = "$&/child.md";

    const error = await captureError(paths.readTemplate(label, makeToolContext(), guard));

    expect(error.message).toBe(
      `Template path "${label}" is not allowed by templatePaths or was not found.`,
    );
    expect(error.message).not.toContain(slash(directory));
  });

  it("rejects a relative traversal path", async () => {
    const directory = await tempDir();
    const outside = await tempDir();
    const file = await writeTemp(outside, "outside.md", "secret");
    const { paths, guard } = await setupPaths(directory);
    const traversal = relative(directory, file);

    await expect(paths.readTemplate(traversal, makeToolContext(), guard)).rejects.toThrow(
      /not allowed by templatePaths/,
    );
  });

  it("matches dotfiles such as .env", async () => {
    const directory = await tempDir();
    await writeTemp(directory, ".env", "SECRET=1");
    const { paths, guard } = await setupPaths(directory);

    const result = await paths.readTemplate(".env", makeToolContext(), guard);
    expect(result.text).toBe("SECRET=1");
  });

  it("allows external patterns and asserts external_directory", async () => {
    const project = await tempDir();
    const external = await tempDir();
    const realExternal = await realpath(external);
    const file = await writeTemp(external, "task.md", "External");
    const { paths, calls, guard } = await setupPaths(project, {
      templatePaths: ["**/*", slash(join(realExternal, "**/*"))],
    });

    const result = await paths.readTemplate(file, makeToolContext(), guard);
    const realFile = await realpath(file);

    expect(result.text).toBe("External");
    expect(calls.map((call) => call.action)).toEqual(["external_directory", "read"]);
    expect(calls[0].save).toEqual([slash(join(await realpath(project), "*"))]);
    expect(calls[1].resources).toEqual([slash(realFile)]);
  });

  it("rejects an external read when external_directory is denied", async () => {
    const project = await tempDir();
    const external = await tempDir();
    const realExternal = await realpath(external);
    const file = await writeTemp(external, "task.md", "External");
    const { paths } = await setupPaths(project, {
      templatePaths: ["**/*", slash(join(realExternal, "**/*"))],
    });
    const calls: any[] = [];
    const guard = createPermissionGuard({
      assert: async (input) => {
        calls.push(input);
        if (input.action === "external_directory") {
          throw new ToolError({ message: "external denied" });
        }
      },
    });

    const error = await captureError(paths.readTemplate(file, makeToolContext(), guard));

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toBe("external denied");
    expect(calls.map((call) => call.action)).toEqual(["external_directory"]);
  });

  it("rejects a symlink that escapes the allowlist", async () => {
    const project = await tempDir();
    const external = await tempDir();
    await writeTemp(external, "secret.md", "secret");
    try {
      await symlink(
        external,
        join(project, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    const { paths, guard } = await setupPaths(project);

    await expect(
      paths.readTemplate("linked/secret.md", makeToolContext(), guard),
    ).rejects.toThrow(/not allowed by templatePaths/);
  });

  it.skipIf(!canCreateDirectorySymlink)(
    "allows an internal symlink that resolves inside templatePaths",
    async () => {
      const directory = await tempDir();
      await writeTemp(directory, "templates/task.md", "Hello");
      await symlink(
        join(directory, "templates"),
        join(directory, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const { paths, calls, guard } = await setupPaths(directory, {
        templatePaths: ["templates/**/*"],
      });

      const result = await paths.readTemplate("linked/task.md", makeToolContext(), guard);

      expect(result.text).toBe("Hello");
      expect(result.resource).toBe("templates/task.md");
      expect(calls.map((call) => call.action)).toEqual(["read"]);
    },
  );

  it.skipIf(!canCreateHardLink)(
    "rejects a static hard link to an outside file by default",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      const secret = await writeTemp(outside, "secret.md", "TOP-SECRET");
      const inside = join(project, "templates", "innocent.md");
      await mkdir(dirname(inside), { recursive: true });
      await link(secret, inside);
      const { paths, calls, guard } = await setupPaths(project, {
        templatePaths: ["templates/**/*"],
      });

      const error = await captureError(
        paths.readTemplate("templates/innocent.md", makeToolContext(), guard),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toBe(
        'Template file "templates/innocent.md" has multiple hard links; hard-linked templates are disabled. Set allowHardLinkedTemplates: true to allow them.',
      );
      expect(error.message).not.toContain("TOP-SECRET");
      expect(calls).toEqual([]);
    },
  );

  it.skipIf(!canCreateHardLink)(
    "reads a hard-linked template when allowHardLinkedTemplates is true",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      const secret = await writeTemp(outside, "secret.md", "TOP-SECRET");
      const inside = join(project, "templates", "innocent.md");
      await mkdir(dirname(inside), { recursive: true });
      await link(secret, inside);
      const { paths, guard } = await setupPaths(project, {
        templatePaths: ["templates/**/*"],
        allowHardLinkedTemplates: true,
      });

      const result = await paths.readTemplate(
        "templates/innocent.md",
        makeToolContext(),
        guard,
      );
      expect(result.text).toBe("TOP-SECRET");
    },
  );

  it.skipIf(!canCreateHardLink)(
    "rejects a hard link swapped in during the read permission prompt",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      const task = await writeTemp(project, "templates/task.md", "safe");
      const secret = await writeTemp(outside, "secret.md", "PROMPT-SECRET");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "read") return;
          await unlink(task);
          await link(secret, task);
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.readTemplate("templates/task.md", makeToolContext(), guard),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(
        /multiple hard links|changed during permission check/,
      );
      expect(error.message).not.toContain("PROMPT-SECRET");
    },
  );

  it.skipIf(!canCreateHardLink)(
    "rejects a hard link swapped in during the read prompt when hard links are allowed",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      const task = await writeTemp(project, "templates/task.md", "safe");
      const secret = await writeTemp(outside, "secret.md", "PROMPT-SECRET");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "read") return;
          await unlink(task);
          await link(secret, task);
        },
      });
      const { paths } = await setupPaths(project, {
        allowHardLinkedTemplates: true,
      });

      const error = await captureError(
        paths.readTemplate("templates/task.md", makeToolContext(), guard),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(/changed during permission check/);
      expect(error.message).not.toContain("PROMPT-SECRET");
    },
  );

  it.skipIf(!canCreateFifo)(
    "rejects a FIFO swapped in during the read permission prompt without blocking",
    async () => {
      const project = await tempDir();
      const task = await writeTemp(project, "templates/task.md", "safe");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "read") return;
          await unlink(task);
          execFileSync("mkfifo", [task]);
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.readTemplate("templates/task.md", makeToolContext(), guard),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(/not a file|changed during permission check/);
    },
    10_000,
  );

  it("rejects a regular file replaced during the read permission prompt", async () => {
    const project = await tempDir();
    const task = await writeTemp(project, "templates/task.md", "safe");
    const guard = createPermissionGuard({
      assert: async (input) => {
        if (input.action !== "read") return;
        await unlink(task);
        await writeFile(task, "SWAPPED-SECRET", "utf8");
      },
    });
    const { paths } = await setupPaths(project);

    const error = await captureError(
      paths.readTemplate("templates/task.md", makeToolContext(), guard),
    );

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toMatch(/changed during permission check/);
    expect(error.message).not.toContain("SWAPPED-SECRET");
  });

  it.skipIf(!canCreateFileSymlink)(
    "rejects a symlink swapped in during the read permission prompt",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      const task = await writeTemp(project, "templates/task.md", "safe");
      const secret = await writeTemp(outside, "secret.md", "PROMPT-SECRET");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "read") return;
          await unlink(task);
          await symlink(secret, task, "file");
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.readTemplate("templates/task.md", makeToolContext(), guard),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(/changed during permission check/);
      expect(error.message).not.toContain("PROMPT-SECRET");
    },
  );

  it.skipIf(!canCreateDirectorySymlink)(
    "rejects a parent directory swapped for a symlink during the read prompt",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      await writeTemp(project, "templates/task.md", "safe");
      await writeTemp(outside, "task.md", "PROMPT-SECRET");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "read") return;
          await rm(join(project, "templates"), { recursive: true, force: true });
          await symlink(
            outside,
            join(project, "templates"),
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.readTemplate("templates/task.md", makeToolContext(), guard),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(/changed during permission check/);
      expect(error.message).not.toContain("PROMPT-SECRET");
    },
  );

  it("deduplicates permission assertions within one call", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths, calls, guard } = await setupPaths(directory);
    const context = makeToolContext();

    await paths.readTemplate("a.md", context, guard);
    await paths.readTemplate("a.md", context, guard);

    expect(calls.filter((call) => call.action === "read")).toHaveLength(1);
  });

  it("deduplicates concurrent permission assertions", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths } = await setupPaths(directory);
    const calls: any[] = [];
    const guard = createPermissionGuard({
      assert: async (input) => {
        calls.push(input);
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    const context = makeToolContext();

    await Promise.all([
      paths.readTemplate("a.md", context, guard),
      paths.readTemplate("a.md", context, guard),
    ]);

    expect(calls.filter((call) => call.action === "read")).toHaveLength(1);
  });

  it("rejects a file over maxTemplateBytes", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "big.md", "x".repeat(2048));
    const { paths, guard } = await setupPaths(directory, {
      limits: { maxTemplateBytes: 1024 },
    });

    await expect(paths.readTemplate("big.md", makeToolContext(), guard)).rejects.toThrow(
      /maxTemplateBytes/,
    );
  });

  it("rejects a template that grows past maxTemplateBytes after the pre-check", async () => {
    const directory = await tempDir();
    const file = await writeTemp(directory, "grow.md", "x".repeat(1024));
    const guard = createPermissionGuard({
      assert: async (input) => {
        if (input.action !== "read") return;
        await writeFile(file, "x".repeat(4096), "utf8");
      },
    });
    const { paths } = await setupPaths(directory, {
      limits: { maxTemplateBytes: 1024 },
    });

    const error = await captureError(
      paths.readTemplate("grow.md", makeToolContext(), guard),
    );

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toMatch(/maxTemplateBytes/);
  });

  it("rejects NUL bytes", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "binary.md", "a\0b");
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.readTemplate("binary.md", makeToolContext(), guard),
    ).rejects.toThrow(/NUL/);
  });

  it("rejects other binary control bytes", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "binary.md", "a\u0001b");
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.readTemplate("binary.md", makeToolContext(), guard),
    ).rejects.toThrow(/binary control/);
  });

  it("rejects invalid UTF-8 with the display path", async () => {
    const directory = await tempDir();
    await writeFile(join(directory, "binary.md"), Buffer.from([0x61, 0xff, 0x62]));
    const { paths, guard } = await setupPaths(directory);

    const error = await captureError(
      paths.readTemplate("binary.md", makeToolContext(), guard),
    );

    expect(error.message).toBe('Template file "binary.md" is not valid UTF-8 text.');
    expect(error.message).not.toContain(slash(directory));
  });

  it("strips a UTF-8 BOM", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "bom.md", "\uFEFFHello");
    const { paths, guard } = await setupPaths(directory);

    const result = await paths.readTemplate("bom.md", makeToolContext(), guard);
    expect(result.text).toBe("Hello");
  });

  it("uses the uniform message for an allowed but missing file", async () => {
    const directory = await tempDir();
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.readTemplate("missing.md", makeToolContext(), guard),
    ).rejects.toThrow(
      /^Template path "missing\.md" is not allowed by templatePaths or was not found\.$/,
    );
  });

  it("disables file templates when templatePaths is empty", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths, guard } = await setupPaths(directory, { templatePaths: [] });

    await expect(paths.readTemplate("a.md", makeToolContext(), guard)).rejects.toThrow(
      /disabled/,
    );
  });

  it("rejects a directory", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "templates/task.md", "A");
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.readTemplate("templates", makeToolContext(), guard),
    ).rejects.toThrow(/not a file|not allowed/);
  });

  it("propagates a permission denial", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths } = await setupPaths(directory);
    const guard = createPermissionGuard({
      assert: async () => {
        throw new ToolError({ message: "denied" });
      },
    });

    await expect(paths.readTemplate("a.md", makeToolContext(), guard)).rejects.toThrow(
      /denied/,
    );
  });

  it("rejects a missing session before reading", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths, calls, guard } = await setupPaths(directory);

    await expect(
      paths.readTemplate("a.md", makeToolContext({ sessionID: "" }), guard),
    ).rejects.toThrow(/session is unknown/);
    expect(calls).toEqual([]);
  });

  it("matches a real path under the project", async () => {
    const directory = await tempDir();
    const { paths } = await setupPaths(directory);
    const real = await realpath(directory);

    expect(paths.matchesTemplatePath(join(real, "a.md"))).toBe(true);
    expect(paths.matchesTemplatePath(join(dirname(real), "outside.md"))).toBe(false);
  });

  it("does not match relative patterns across Windows drives", async () => {
    if (process.platform !== "win32") return;
    const directory = await tempDir();
    const { paths } = await setupPaths(directory);
    const otherDrive = directory[0]?.toUpperCase() === "D" ? "C" : "D";

    expect(paths.matchesTemplatePath(`${otherDrive}:/secret/a.md`)).toBe(false);
  });

  it("resolves relative paths and allowlists from the project directory", async () => {
    const project = await tempDir();
    const location = join(project, "sub");
    await mkdir(location, { recursive: true });
    await writeTemp(project, "templates/task.md", "Task");
    const { paths, calls, guard } = await setupPaths(
      location,
      { templatePaths: ["templates/**/*"] },
      project,
    );

    const read = await paths.readTemplate("templates/task.md", makeToolContext(), guard);
    expect(read.text).toBe("Task");
    expect(read.resource).toBe("../templates/task.md");
    expect(calls.map((call) => call.action)).toEqual(["read"]);

    const written = await paths.writeTemplate(
      "build/out.txt",
      "x",
      makeToolContext(),
      guard,
      { overwrite: false },
    );
    expect(written.path).toBe("../build/out.txt");
    expect(await readFile(join(project, "build/out.txt"), "utf8")).toBe("x");
  });

  it("treats names starting with two dots as internal", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "..cache/a.md", "A");
    const { paths, calls, guard } = await setupPaths(directory);

    const result = await paths.readTemplate("..cache/a.md", makeToolContext(), guard);
    expect(result.text).toBe("A");
    expect(calls.map((call) => call.action)).toEqual(["read"]);
  });

  it("matches a project directory containing glob characters", async () => {
    const parent = await tempDir();
    const directory = join(parent, "project[1]");
    await mkdir(directory, { recursive: true });
    await writeTemp(directory, "task.md", "A");
    const { paths, guard } = await setupPaths(directory);

    const result = await paths.readTemplate("task.md", makeToolContext(), guard);
    expect(result.text).toBe("A");
  });

  it("matches a relative external pattern", async () => {
    const parent = await tempDir();
    const project = join(parent, "project");
    const external = join(parent, "external");
    await mkdir(project, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeTemp(external, "task.md", "External");
    const { paths, calls, guard } = await setupPaths(project, {
      templatePaths: ["**/*", "../external/**/*"],
    });

    const result = await paths.readTemplate(
      "../external/task.md",
      makeToolContext(),
      guard,
    );
    expect(result.text).toBe("External");
    expect(calls.map((call) => call.action)).toEqual(["external_directory", "read"]);
  });

  it("ignores negation patterns instead of widening the allowlist", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "secret/a.md", "S");
    const { paths, guard } = await setupPaths(directory, {
      templatePaths: ["!secret/**"],
    });

    await expect(
      paths.readTemplate("secret/a.md", makeToolContext(), guard),
    ).rejects.toThrow(/not allowed by templatePaths/);
  });

  it("fails closed for malformed and rejected glob patterns", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const malformed = await setupPaths(directory, { templatePaths: ["["] });

    await expect(
      malformed.paths.readTemplate("a.md", makeToolContext(), malformed.guard),
    ).rejects.toThrow(
      /^Template path "a\.md" is not allowed by templatePaths or was not found\.$/,
    );

    const config = {
      ...resolveConfig({}),
      templatePaths: ["a".repeat(70_000)],
    };
    const paths = await createTemplatePaths({
      config,
      location: { directory, project: { directory } },
    });
    const guard = createPermissionGuard({ assert: async () => {} });

    await expect(paths.readTemplate("a.md", makeToolContext(), guard)).rejects.toThrow(
      /^Template path "a\.md" is not allowed by templatePaths or was not found\.$/,
    );
  });

  it("propagates an aborted read", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths, guard } = await setupPaths(directory);
    const controller = new AbortController();
    controller.abort();

    try {
      await paths.readTemplate(
        "a.md",
        makeToolContext({ signal: controller.signal }),
        guard,
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("aborts when the read permission check aborts mid-flight", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "a.md", "A");
    const { paths } = await setupPaths(directory);
    const controller = new AbortController();
    const guard = createPermissionGuard({
      assert: async () => {
        controller.abort();
      },
    });

    const error = await captureError(
      paths.readTemplate("a.md", makeToolContext({ signal: controller.signal }), guard),
    );

    expect(error.name).toBe("AbortError");
  });
});

describe("template writes", () => {
  it("writes a file and checks edit permission", async () => {
    const directory = await tempDir();
    const { paths, calls, guard } = await setupPaths(directory);

    const result = await paths.writeTemplate(
      "build/a.txt",
      "Hello",
      makeToolContext(),
      guard,
      { overwrite: false },
    );

    expect(result.path).toBe("build/a.txt");
    expect(result.bytes).toBe(5);
    expect(await readFile(join(directory, "build/a.txt"), "utf8")).toBe("Hello");
    expect(calls.some((call) => call.action === "edit")).toBe(true);
  });

  it("refuses to overwrite unless asked", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "build/a.txt", "old");
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.writeTemplate("build/a.txt", "new", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/already exists/);

    await paths.writeTemplate("build/a.txt", "new", makeToolContext(), guard, {
      overwrite: true,
    });
    expect(await readFile(join(directory, "build/a.txt"), "utf8")).toBe("new");
  });

  it("enforces buildPaths without echoing the patterns", async () => {
    const directory = await tempDir();
    const { paths, guard } = await setupPaths(directory, {
      buildPaths: ["allowed/**/*"],
    });

    const error = await captureError(
      paths.writeTemplate("other/a.txt", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    );

    expect(error.message).toBe('Output path "other/a.txt" is not allowed by buildPaths.');
    expect(error.message).not.toContain("allowed/**/*");
    expect(error.message).not.toContain("Allowed patterns");
  });

  it("disables writes when buildPaths is empty", async () => {
    const directory = await tempDir();
    const { paths, guard } = await setupPaths(directory, { buildPaths: [] });

    await expect(
      paths.writeTemplate("a.txt", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects traversal and directories", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "build/dir/file.txt", "x");
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.writeTemplate("../outside.txt", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/not allowed by buildPaths/);
    await expect(
      paths.writeTemplate("build/dir", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/is a directory/);
  });

  it.skipIf(!canCreateFifo)("rejects a non-regular output file", async () => {
    const directory = await tempDir();
    const fifo = join(directory, "build", "pipe");
    await mkdir(dirname(fifo), { recursive: true });
    execFileSync("mkfifo", [fifo]);
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.writeTemplate("build/pipe", "x", makeToolContext(), guard, {
        overwrite: true,
      }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("writes outside the project when buildPaths allows it", async () => {
    const project = await tempDir();
    const external = await tempDir();
    const realExternal = await realpath(external);
    const { paths, calls, guard } = await setupPaths(project, {
      buildPaths: ["**/*", slash(join(realExternal, "**/*"))],
    });
    const target = join(realExternal, "out.txt");

    const result = await paths.writeTemplate(target, "x", makeToolContext(), guard, {
      overwrite: false,
    });

    expect(result.path).toBe(slash(target));
    expect(calls.map((call) => call.action)).toEqual(["external_directory", "edit"]);
    expect(calls[0].resources).toEqual([slash(join(realExternal, "*"))]);
    expect(calls[0].save).toEqual([slash(join(await realpath(project), "*"))]);
    expect(calls[1].resources).toEqual([slash(target)]);
    expect(calls[1].save).toEqual(["*"]);
    expect(await readFile(target, "utf8")).toBe("x");
  });

  it("rejects an external write when external_directory is denied", async () => {
    const project = await tempDir();
    const external = await tempDir();
    const realExternal = await realpath(external);
    const { paths } = await setupPaths(project, {
      buildPaths: ["**/*", slash(join(realExternal, "**/*"))],
    });
    const target = join(realExternal, "out.txt");
    const calls: any[] = [];
    const guard = createPermissionGuard({
      assert: async (input) => {
        calls.push(input);
        if (input.action === "external_directory") {
          throw new ToolError({ message: "external denied" });
        }
      },
    });

    const error = await captureError(
      paths.writeTemplate(target, "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    );

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toBe("external denied");
    expect(calls.map((call) => call.action)).toEqual(["external_directory"]);
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rejects a symlinked parent that escapes buildPaths", async () => {
    const project = await tempDir();
    const external = await tempDir();
    try {
      await symlink(
        external,
        join(project, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    const { paths, guard } = await setupPaths(project);

    await expect(
      paths.writeTemplate("linked/out.txt", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/not allowed by buildPaths/);
  });

  it("enforces maxRenderedBytes on writes", async () => {
    const directory = await tempDir();
    const { paths, guard } = await setupPaths(directory, {
      limits: { maxRenderedBytes: 1024 },
    });

    await expect(
      paths.writeTemplate("big.txt", "x".repeat(2000), makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/maxRenderedBytes/);
  });

  it("propagates an edit permission denial", async () => {
    const directory = await tempDir();
    const { paths } = await setupPaths(directory);
    const guard = createPermissionGuard({
      assert: async () => {
        throw new ToolError({ message: "denied" });
      },
    });

    await expect(
      paths.writeTemplate("a.txt", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/denied/);
  });

  it("deduplicates write permission assertions", async () => {
    const directory = await tempDir();
    const { paths, calls, guard } = await setupPaths(directory);
    const context = makeToolContext();

    await paths.writeTemplate("a.txt", "x", context, guard, { overwrite: false });
    await paths.writeTemplate("a.txt", "y", context, guard, { overwrite: true });

    expect(calls.filter((call) => call.action === "edit")).toHaveLength(1);
  });

  it("rejects a dangling file symlink output path", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "build/.keep", "");
    await writeTemp(directory, "outside/.keep", "");
    const linkPath = join(directory, "build", "link.txt");
    const target = join(directory, "outside", "evil.txt");
    try {
      await symlink(target, linkPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    const { paths, guard } = await setupPaths(directory);

    for (const overwrite of [false, true]) {
      await expect(
        paths.writeTemplate("build/link.txt", "x", makeToolContext(), guard, {
          overwrite,
        }),
      ).rejects.toThrow(/broken symlink/);
    }
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rejects a dangling directory symlink output path", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "build/.keep", "");
    await writeTemp(directory, "outside/.keep", "");
    const linkPath = join(directory, "build", "link");
    const target = join(directory, "outside", "evil");
    try {
      await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.writeTemplate("build/link", "x", makeToolContext(), guard, {
        overwrite: false,
      }),
    ).rejects.toThrow(/broken symlink/);
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rejects an existing file symlink that escapes buildPaths", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "build/.keep", "");
    await writeTemp(directory, "outside/evil.txt", "outside");
    const linkPath = join(directory, "build", "link.txt");
    const target = join(directory, "outside", "evil.txt");
    try {
      await symlink(target, linkPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }
    const { paths, guard } = await setupPaths(directory);

    for (const overwrite of [false, true]) {
      await expect(
        paths.writeTemplate("build/link.txt", "x", makeToolContext(), guard, {
          overwrite,
        }),
      ).rejects.toThrow(/not allowed by buildPaths/);
    }
    expect(await readFile(target, "utf8")).toBe("outside");
  });

  it("refuses to overwrite a hard-linked output file", async () => {
    const directory = await tempDir();
    await writeTemp(directory, "build/.keep", "");
    const outside = await writeTemp(directory, "outside/secret.txt", "secret");
    const inside = join(directory, "build", "link.txt");
    try {
      await link(outside, inside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "EXDEV") return;
      throw error;
    }
    const { paths, guard } = await setupPaths(directory);

    await expect(
      paths.writeTemplate("build/link.txt", "x", makeToolContext(), guard, {
        overwrite: true,
      }),
    ).rejects.toThrow(
      'Output file "build/link.txt" has multiple hard links; refusing to overwrite it.',
    );
    expect(await readFile(outside, "utf8")).toBe("secret");
  });

  it.skipIf(!canCreateHardLink)(
    "refuses a hard-linked output file when allowHardLinkedTemplates is true",
    async () => {
      const directory = await tempDir();
      await writeTemp(directory, "build/.keep", "");
      const outside = await writeTemp(directory, "outside/secret.txt", "secret");
      const inside = join(directory, "build", "link.txt");
      await link(outside, inside);
      const { paths, guard } = await setupPaths(directory, {
        allowHardLinkedTemplates: true,
      });

      await expect(
        paths.writeTemplate("build/link.txt", "x", makeToolContext(), guard, {
          overwrite: true,
        }),
      ).rejects.toThrow(
        'Output file "build/link.txt" has multiple hard links; refusing to overwrite it.',
      );
      expect(await readFile(outside, "utf8")).toBe("secret");
    },
  );

  it.skipIf(!canCreateHardLink)(
    "rejects a hard link created during the write permission prompt",
    async () => {
      const project = await tempDir();
      await writeTemp(project, "build/.keep", "");
      const outside = await tempDir();
      const victim = await writeTemp(outside, "victim.txt", "VICTIM");
      const target = join(project, "build", "out.txt");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "edit") return;
          await link(victim, target);
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.writeTemplate("build/out.txt", "PWNED", makeToolContext(), guard, {
          overwrite: false,
        }),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(/appeared during permission check/);
      expect(await readFile(victim, "utf8")).toBe("VICTIM");
    },
  );

  it("rejects a regular file created during the write permission prompt", async () => {
    const project = await tempDir();
    await writeTemp(project, "build/.keep", "");
    const target = join(project, "build", "out.txt");
    const guard = createPermissionGuard({
      assert: async (input) => {
        if (input.action !== "edit") return;
        await writeFile(target, "intruder", "utf8");
      },
    });
    const { paths } = await setupPaths(project);

    const error = await captureError(
      paths.writeTemplate("build/out.txt", "PWNED", makeToolContext(), guard, {
        overwrite: false,
      }),
    );

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toMatch(/appeared during permission check/);
    expect(await readFile(target, "utf8")).toBe("intruder");
  });

  it.skipIf(!canCreateHardLink)(
    "rejects a hard link swapped in during the overwrite permission prompt",
    async () => {
      const project = await tempDir();
      const target = await writeTemp(project, "build/out.txt", "old");
      const outside = await tempDir();
      const victim = await writeTemp(outside, "victim.txt", "VICTIM");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "edit") return;
          await unlink(target);
          await link(victim, target);
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.writeTemplate("build/out.txt", "PWNED", makeToolContext(), guard, {
          overwrite: true,
        }),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(
        /multiple hard links|changed during permission check/,
      );
      expect(await readFile(victim, "utf8")).toBe("VICTIM");
    },
  );

  it("rejects a regular file replaced during the overwrite permission prompt", async () => {
    const project = await tempDir();
    const target = await writeTemp(project, "build/out.txt", "old");
    const guard = createPermissionGuard({
      assert: async (input) => {
        if (input.action !== "edit") return;
        await unlink(target);
        await writeFile(target, "replaced", "utf8");
      },
    });
    const { paths } = await setupPaths(project);

    const error = await captureError(
      paths.writeTemplate("build/out.txt", "PWNED", makeToolContext(), guard, {
        overwrite: true,
      }),
    );

    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toMatch(/changed during permission check/);
    expect(await readFile(target, "utf8")).toBe("replaced");
  });

  it.skipIf(!canCreateDirectorySymlink)(
    "rejects a parent directory swapped for a symlink during the write prompt",
    async () => {
      const project = await tempDir();
      const outside = await tempDir();
      await writeTemp(project, "build/.keep", "");
      await writeTemp(outside, ".keep", "");
      const guard = createPermissionGuard({
        assert: async (input) => {
          if (input.action !== "edit") return;
          await rm(join(project, "build"), { recursive: true, force: true });
          await symlink(
            outside,
            join(project, "build"),
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      });
      const { paths } = await setupPaths(project);

      const error = await captureError(
        paths.writeTemplate("build/out.txt", "PWNED", makeToolContext(), guard, {
          overwrite: false,
        }),
      );

      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toMatch(/changed during permission check/);
      await expect(readFile(join(outside, "out.txt"), "utf8")).rejects.toThrow();
    },
  );

  it("propagates an aborted write", async () => {
    const directory = await tempDir();
    const { paths, guard } = await setupPaths(directory);
    const controller = new AbortController();
    controller.abort();

    try {
      await paths.writeTemplate(
        "a.txt",
        "x",
        makeToolContext({ signal: controller.signal }),
        guard,
        { overwrite: false },
      );
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
      return;
    }
    throw new Error("Expected a rejection");
  });

  it("aborts when the write permission check aborts mid-flight", async () => {
    const directory = await tempDir();
    const { paths } = await setupPaths(directory);
    const controller = new AbortController();
    const guard = createPermissionGuard({
      assert: async () => {
        controller.abort();
      },
    });

    const error = await captureError(
      paths.writeTemplate(
        "a.txt",
        "x",
        makeToolContext({ signal: controller.signal }),
        guard,
        { overwrite: false },
      ),
    );

    expect(error.name).toBe("AbortError");
    await expect(readFile(join(directory, "a.txt"), "utf8")).rejects.toThrow();
  });
});
