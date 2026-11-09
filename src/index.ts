/**
 * Render Handlebars templates into tool arguments and build template files.
 * Model-facing surface: `template_call` and `template_build`; in Code Mode,
 * `tools.template.call` and `tools.template.build`.
 */

import { Plugin } from "@opencode/plugin";
import type { Info } from "@opencode/plugin/promise/tool";
import { createChainRenderer } from "./chain";
import { resolveConfig } from "./config";
import { OPENCODE_REQUIREMENT } from "./errors";
import { createTemplatePaths } from "./paths";
import { registerSkill } from "./skill";
import { effectiveToolName } from "./tool-name";
import { registerTools } from "./tools";
import { TOOL } from "./tools/names";

export default Plugin.define({
  id: "tool-templates",

  async setup(ctx) {
    const config = resolveConfig(ctx.options);

    const rawToolList = (ctx.tool as { list?: unknown } | undefined)?.list;
    const rawPermission = (ctx.permission as { assert?: unknown } | undefined)?.assert;
    if (typeof rawToolList !== "function" || typeof rawPermission !== "function") {
      throw new Error(OPENCODE_REQUIREMENT);
    }
    const toolList = rawToolList.bind(ctx.tool) as () => Promise<
      readonly (Info & { id: string })[]
    >;

    const paths = await createTemplatePaths({ config, location: ctx.location });
    const renderer = createChainRenderer({ config, paths });

    const toolsRegistration = await ctx.tool.transform((editor) => {
      registerTools(editor, {
        config,
        renderer,
        paths,
        permission: ctx.permission,
        toolList,
        selfToolName: effectiveToolName(config.namespace, TOOL.call),
      });
    });

    const skillRegistration = config.registerSkill
      ? await registerSkill(ctx.skill)
      : undefined;

    return async () => {
      const disposals = [
        { label: "skill", dispose: async () => skillRegistration?.dispose() },
        { label: "tools", dispose: async () => toolsRegistration.dispose() },
      ];
      const results = await Promise.allSettled(disposals.map((entry) => entry.dispose()));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          console.error(
            `tool-templates: failed to dispose ${disposals[index].label} registration`,
            result.reason,
          );
        }
      }
    };
  },
});
