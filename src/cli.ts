import { defineCommand, runMain } from "citty";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "fs";
import { basename, join } from "path";
import { homedir } from "os";

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, { installPath: string }[]>;
}

function findSkills(
  dir: string,
  results: { name: string; dir: string }[],
): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findSkills(full, results);
    else if (entry.name === "SKILL.md") {
      results.push({ name: basename(dir), dir });
    }
  }
}

const link = defineCommand({
  meta: { name: "link", description: "Symlink Claude Code skills into ~/.agents/skills/" },
  args: {
    dest: {
      type: "string",
      description: "Destination directory",
      default: join(homedir(), ".agents", "skills"),
    },
  },
  run({ args }) {
    const registryPath = join(getClaudeConfigDir(), "plugins", "installed_plugins.json");
    if (!existsSync(registryPath)) {
      console.error(`Not found: ${registryPath}`);
      process.exit(1);
    }

    const registry = JSON.parse(
      readFileSync(registryPath, "utf-8"),
    ) as InstalledPluginsFile;

    // Clean and recreate destination
    rmSync(args.dest, { recursive: true, force: true });
    mkdirSync(args.dest, { recursive: true });

    const linked = new Set<string>();

    for (const [key, entries] of Object.entries(registry.plugins)) {
      const installPath = entries[0]?.installPath;
      if (!installPath) continue;
      const pluginName = key.replace(/@.*$/, "");

      const skills: { name: string; dir: string }[] = [];
      findSkills(installPath, skills);

      for (const skill of skills) {
        // When SKILL.md is at install root, use plugin name instead of dirname
        const name = skill.dir === installPath ? pluginName : skill.name;
        const dest = join(args.dest, name);
        if (linked.has(name)) continue;
        linked.add(name);
        symlinkSync(skill.dir, dest);
        console.log(`${name} → ${skill.dir}`);
      }
    }

    console.log(`\n${linked.size} skills linked to ${args.dest}`);
  },
});

const main = defineCommand({
  meta: {
    name: "opencode-claude-skills",
    description: "CLI for managing Claude Code skills",
  },
  subCommands: { link },
});

runMain(main);
