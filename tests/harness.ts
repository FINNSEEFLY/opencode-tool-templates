import { afterEach } from "bun:test";
import plugin from "../src/index";
import { effectiveToolName } from "../src/tool-name";
import { makeToolContext } from "./context";
import { tempDir, writeTemp } from "./temp";

export interface HarnessOptions {
  options?: Record<string, any>;
  noToolList?: boolean;
  noPermission?: boolean;
}

export function makeHarness(input: HarnessOptions = {}) {
  const tools = new Map<string, any>();
  const skills = new Map<string, any>();
  const namespaces: any[] = [];
  const permissionCalls: any[] = [];
  let permissionError: Error | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let directory = "";
  let setupStarted = false;

  const toolEditor = {
    namespace: (value: any) => {
      namespaces.push(value);
    },
    add: (tool: any) => {
      const namespace = tool.options?.namespace;
      const id = effectiveToolName(
        namespace === undefined ? undefined : String(namespace),
        String(tool.name),
      );
      tools.set(id, { ...tool, id });
    },
    update: () => undefined,
    remove: (id: string) => {
      tools.delete(id);
    },
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
  };

  const ctx: any = {
    options: input.options ?? {},
    location: undefined,
    tool: {
      list: async () => [...tools.values()],
      transform: async (callback: (editor: any) => void) => {
        const before = new Set(tools.keys());
        callback(toolEditor);
        const added = [...tools.keys()].filter((id) => !before.has(id));
        return {
          dispose: async () => {
            for (const id of added) tools.delete(id);
          },
        };
      },
    },
    permission: {
      assert: async (value: any) => {
        permissionCalls.push(value);
        if (permissionError) throw permissionError;
      },
    },
    skill: {
      list: async () => [...skills.values()],
      reload: async () => undefined,
      transform: async (callback: (editor: any) => void) => {
        const editor = {
          list: () => [...skills.values()],
          get: (id: string) => skills.get(id),
          add: (skill: any) => skills.set(skill.id, skill),
          update: (id: string, update: (skill: any) => void) => {
            const current = skills.get(id);
            if (current) update(current);
          },
          remove: (id: string) => skills.delete(id),
        };
        const before = new Set(skills.keys());
        callback(editor);
        const added = [...skills.keys()].filter((id) => !before.has(id));
        return {
          dispose: async () => {
            for (const id of added) skills.delete(id);
          },
        };
      },
    },
  };

  if (input.noToolList) delete ctx.tool.list;
  if (input.noPermission) delete ctx.permission;

  const setup = async () => {
    if (setupStarted) {
      throw new Error(
        "makeHarness setup() has already been called; create a new harness per test",
      );
    }
    setupStarted = true;
    directory = await tempDir();
    ctx.location = { directory, project: { directory } };
    cleanup = (await plugin.setup(ctx)) as () => Promise<void>;
    return cleanup;
  };

  const addTarget = (target: any) => {
    const id = target.id ?? target.name;
    const entry = {
      name: id,
      description: "",
      input: { type: "object", additionalProperties: true },
      execute: async () => ({ content: "" }),
      ...target,
      id,
    };
    tools.set(id, entry);
    return entry;
  };

  const callTool = (value: any, context: any = makeToolContext()) => {
    const tool = [...tools.values()].find((entry) => entry.name === "call");
    if (!tool) throw new Error("template_call is not registered; call setup() first");
    return tool.execute(value, context);
  };

  const callBuild = (value: any, context: any = makeToolContext()) => {
    const tool = [...tools.values()].find((entry) => entry.name === "build");
    if (!tool) throw new Error("template_build is not registered; call setup() first");
    return tool.execute(value, context);
  };

  const write = (relative: string, content: string) =>
    writeTemp(directory, relative, content);

  const dispose = async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  };

  afterEach(async () => {
    await dispose();
  });

  return {
    ctx,
    setup,
    addTarget,
    callTool,
    callBuild,
    write,
    dispose,
    tools,
    skills,
    namespaces,
    permissionCalls,
    setPermissionError: (error: Error | undefined) => {
      permissionError = error;
    },
    get directory() {
      return directory;
    },
  };
}
