import { type Plugin, tool } from "@opencode-ai/plugin";
import { discoverSkills } from "./skills.js";

const plugin: Plugin = async (ctx) => {
  const skills = await discoverSkills(ctx.directory);

  if (skills.length === 0) {
    return {};
  }

  const skillList = skills
    .map((s) => `- ${s.name}: ${s.description || "(no description)"}`)
    .join("\n");

  const skillTool = tool({
    description: `Run a Claude Code skill by name.\n\nAvailable skills:\n${skillList}`,
    args: {
      name: tool.schema.string().describe("Skill name to run"),
      arguments: tool.schema
        .string()
        .optional()
        .describe("Arguments to pass to the skill"),
    },
    async execute(args) {
      const latest = await discoverSkills(ctx.directory);
      const match = latest.find(
        (s) => s.name.toLowerCase() === args.name.toLowerCase(),
      );
      if (!match) {
        const names = latest.map((s) => s.name).join(", ");
        return `Skill "${args.name}" not found. Available: ${names}`;
      }

      let content = match.template;
      if (args.arguments) {
        content = content.replace("$ARGUMENTS", args.arguments);
      }
      return content;
    },
  });

  return {
    tool: { skill: skillTool },

    "experimental.chat.system.transform": async (_input, output) => {
      if (skills.length > 0) {
        output.system.push(
          `The following Claude Code skills are available via the "skill" tool:\n${skillList}`,
        );
      }
    },
  };
};

export default plugin;
