import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Skill, type Plugin } from "@opencode/plugin";

export const SKILL_ID = "tool-templates";
export const SKILL_NAME = "tool-templates";
export const SKILL_DESCRIPTION =
  "Use template_call and template_build to render Handlebars templates into tool arguments, call tools, and assemble or write template files. " +
  "Covers template objects, chains, params, typed values, glob paths, permissions, and output formats.";
export const SKILL_PATH = fileURLToPath(new URL("../SKILL.md", import.meta.url));

/** Read the name/description from a SKILL.md frontmatter block and return the body. */
export const parseSkillFile = (
  text: string,
): { name?: string; description?: string; content: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { content: text };
  const meta = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && value) meta.set(key, value);
  }
  return {
    name: meta.get("name"),
    description: meta.get("description"),
    content: text.slice(match[0].length),
  };
};

/**
 * Register the bundled SKILL.md as a model-facing skill. The tools remain the
 * source of truth; a missing skill file only skips the optional guide.
 */
export const registerSkill = async (
  skill: Plugin.Context["skill"],
  skillPath: string = SKILL_PATH,
) => {
  let skillText: string;
  try {
    skillText = await readFile(skillPath, "utf8");
  } catch (error) {
    console.error(`tool-templates: failed to read SKILL.md at ${skillPath}`, error);
    return undefined;
  }
  try {
    const parsed = parseSkillFile(skillText);
    return await skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(SKILL_ID),
        name: Skill.Name.make(parsed.name ?? SKILL_NAME),
        description: parsed.description ?? SKILL_DESCRIPTION,
        path: Skill.Info.fields.path.make(skillPath),
        content: parsed.content,
      });
    });
  } catch (error) {
    console.error("tool-templates: failed to register SKILL.md", error);
    return undefined;
  }
};
