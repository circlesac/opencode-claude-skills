import { readdir, readFile, access, realpath } from "fs/promises";
import { join, basename, dirname, resolve } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import yaml from "js-yaml";

export interface Skill {
  name: string;
  description: string;
  template: string;
  path: string;
  scope: "project" | "user";
}

interface Frontmatter {
  name?: string;
  description?: string;
  model?: string;
  "argument-hint"?: string;
  "allowed-tools"?: string | string[];
}

function parseFrontmatter(content: string): {
  data: Frontmatter;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  try {
    const data = (yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) ??
      {}) as Frontmatter;
    return { data, body: match[2] };
  } catch {
    return { data: {}, body: match[2] };
  }
}

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function getGitRoot(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function findAncestorSkillDirs(startDir: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const stopDir = getGitRoot(startDir);
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, ".claude", "skills");
    if (!seen.has(candidate)) {
      seen.add(candidate);
      dirs.push(candidate);
    }

    if (stopDir && resolve(current) === resolve(stopDir)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveEntry(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function isMarkdown(name: string): boolean {
  return name.endsWith(".md");
}

async function loadSkillFile(
  skillPath: string,
  resolvedDir: string,
  defaultName: string,
  scope: "project" | "user",
  namePrefix: string,
): Promise<Skill | null> {
  try {
    const content = await readFile(skillPath, "utf-8");
    const { data, body } = parseFrontmatter(content);

    const baseName = data.name || defaultName;
    const name = namePrefix ? `${namePrefix}/${baseName}` : baseName;
    const description = data.description || "";

    const template = [
      `<skill-instruction>`,
      `Base directory for this skill: ${resolvedDir}/`,
      `File references (@path) in this skill are relative to this directory.`,
      ``,
      body.trim(),
      `</skill-instruction>`,
      ``,
      `<user-request>`,
      `$ARGUMENTS`,
      `</user-request>`,
    ].join("\n");

    return { name, description, template, path: skillPath, scope };
  } catch {
    return null;
  }
}

async function loadSkillsFromDir(
  dir: string,
  scope: "project" | "user",
  namePrefix = "",
  depth = 0,
  maxDepth = 2,
): Promise<Skill[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  const seen = new Set<string>();

  const add = (s: Skill | null) => {
    if (s && !seen.has(s.name)) {
      seen.add(s.name);
      skills.push(s);
    }
  };

  // Directories first
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const entryPath = join(dir, entry.name);
    const resolved = await resolveEntry(entryPath);

    // Try SKILL.md
    const skillMd = join(resolved, "SKILL.md");
    if (await exists(skillMd)) {
      add(
        await loadSkillFile(skillMd, resolved, entry.name, scope, namePrefix),
      );
      continue;
    }

    // Try {dirname}.md
    const namedMd = join(resolved, `${entry.name}.md`);
    if (await exists(namedMd)) {
      add(
        await loadSkillFile(namedMd, resolved, entry.name, scope, namePrefix),
      );
      continue;
    }

    // Recurse
    if (depth < maxDepth) {
      const prefix = namePrefix ? `${namePrefix}/${entry.name}` : entry.name;
      const nested = await loadSkillsFromDir(
        resolved,
        scope,
        prefix,
        depth + 1,
        maxDepth,
      );
      for (const s of nested) add(s);
    }
  }

  // Top-level markdown files
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!isMarkdown(entry.name)) continue;

    const entryPath = join(dir, entry.name);
    const baseName = basename(entry.name, ".md");
    add(await loadSkillFile(entryPath, dir, baseName, scope, namePrefix));
  }

  return skills;
}

interface InstalledPlugin {
  scope: string;
  installPath: string;
  version: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPlugin[]>;
}

async function discoverPluginCacheSkills(): Promise<Skill[]> {
  const registryPath = join(getClaudeConfigDir(), "plugins", "installed_plugins.json");
  try {
    const raw = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(raw) as InstalledPluginsFile;

    const skillDirs: string[] = [];
    const rootSkills: { skillMd: string; name: string }[] = [];

    for (const [key, entries] of Object.entries(registry.plugins)) {
      if (!entries.length) continue;
      const latest = entries[entries.length - 1];
      const installPath = latest.installPath;
      const pluginName = key.replace(/@.*$/, "");

      // Check for SKILL.md at install root (e.g. melten-docs plugins)
      const rootSkillMd = join(installPath, "SKILL.md");
      if (await exists(rootSkillMd)) {
        rootSkills.push({ skillMd: rootSkillMd, name: pluginName });
      } else {
        // Otherwise scan standard skill directories
        skillDirs.push(join(installPath, "skills"));
        skillDirs.push(join(installPath, ".claude", "skills"));
      }
    }

    const [dirResults, ...rootResults] = await Promise.all([
      Promise.all(skillDirs.map((d) => loadSkillsFromDir(d, "user"))),
      ...rootSkills.map(({ skillMd, name }) =>
        loadSkillFile(skillMd, dirname(skillMd), name, "user", ""),
      ),
    ]);

    return [
      ...dirResults.flat(),
      ...(rootResults.filter(Boolean) as Skill[]),
    ];
  } catch {
    return [];
  }
}

export async function discoverSkills(directory: string): Promise<Skill[]> {
  const [projectDirs, userDir] = [
    findAncestorSkillDirs(directory),
    join(getClaudeConfigDir(), "skills"),
  ];

  const [projectResults, userResults, pluginResults] = await Promise.all([
    Promise.all(projectDirs.map((d) => loadSkillsFromDir(d, "project"))),
    loadSkillsFromDir(userDir, "user"),
    discoverPluginCacheSkills(),
  ]);

  // Deduplicate: project > user > plugin-cache
  const seen = new Set<string>();
  const all: Skill[] = [];
  for (const skill of [...projectResults.flat(), ...userResults, ...pluginResults]) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      all.push(skill);
    }
  }
  return all;
}
