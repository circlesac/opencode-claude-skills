import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverSkills } from "../src/skills.js";

function writeSkill(dir: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

function writePluginsJson(
  configDir: string,
  plugins: Record<string, { installPath: string }>,
) {
  const file = {
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(plugins).map(([key, val]) => [
        key,
        [{ scope: "user", installPath: val.installPath, version: "0.0.1" }],
      ]),
    ),
  };
  mkdirSync(join(configDir, "plugins"), { recursive: true });
  writeFileSync(
    join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify(file),
  );
}

describe("discoverSkills", () => {
  let tmp: string;
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skills-test-"));
    configDir = join(tmp, ".claude");
    projectDir = join(tmp, "project");
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it("discovers skills from <installPath>/skills/ subdirectory", async () => {
    const pluginDir = join(tmp, "cache", "my-plugin");
    writeSkill(join(pluginDir, "skills", "greet"), "---\ndescription: say hi\n---\nHello $ARGUMENTS");

    writePluginsJson(configDir, {
      "my-plugin@test": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const names = skills.map((s) => s.name);
    expect(names).toContain("greet");
  });

  it("discovers skills from <installPath>/.claude/skills/ subdirectory", async () => {
    const pluginDir = join(tmp, "cache", "my-plugin");
    writeSkill(join(pluginDir, ".claude", "skills", "deploy"), "---\ndescription: deploy it\n---\nDeploy now");

    writePluginsJson(configDir, {
      "my-plugin@test": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const names = skills.map((s) => s.name);
    expect(names).toContain("deploy");
  });

  it("discovers root SKILL.md using plugin name from key", async () => {
    const pluginDir = join(tmp, "cache", "melten-docs");
    writeSkill(pluginDir, "---\ndescription: docs tool\n---\nRun docs");

    writePluginsJson(configDir, {
      "melten-docs@melten": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const match = skills.find((s) => s.name === "melten-docs");
    expect(match).toBeDefined();
    expect(match!.description).toBe("docs tool");
  });

  it("prefers root SKILL.md over scanning skills/ when root exists", async () => {
    const pluginDir = join(tmp, "cache", "my-tool");
    // Root SKILL.md
    writeSkill(pluginDir, "---\ndescription: root skill\n---\nRoot");
    // Also has skills/ subdir with a different skill
    writeSkill(join(pluginDir, "skills", "sub"), "---\ndescription: sub skill\n---\nSub");

    writePluginsJson(configDir, {
      "my-tool@test": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const names = skills.map((s) => s.name);
    expect(names).toContain("my-tool");
    // skills/ subdir should NOT be scanned when root SKILL.md exists
    expect(names).not.toContain("sub");
  });

  it("deduplicates: project skills override plugin skills", async () => {
    // Plugin skill
    const pluginDir = join(tmp, "cache", "plugin");
    writeSkill(join(pluginDir, "skills", "commit"), "---\ndescription: plugin commit\n---\nPlugin");

    writePluginsJson(configDir, {
      "plugin@test": { installPath: pluginDir },
    });

    // Project skill with same name
    mkdirSync(join(projectDir, ".claude", "skills", "commit"), { recursive: true });
    writeFileSync(
      join(projectDir, ".claude", "skills", "commit", "SKILL.md"),
      "---\ndescription: project commit\n---\nProject",
    );

    // Need git root for ancestor detection
    const { execFileSync } = await import("child_process");
    execFileSync("git", ["init"], { cwd: projectDir, stdio: "pipe" });

    const skills = await discoverSkills(projectDir);
    const commit = skills.find((s) => s.name === "commit");
    expect(commit).toBeDefined();
    expect(commit!.description).toBe("project commit");
    expect(commit!.scope).toBe("project");
  });

  it("handles missing installed_plugins.json gracefully", async () => {
    // No plugins file written — should still work
    const skills = await discoverSkills(projectDir);
    expect(skills).toEqual([]);
  });

  it("discovers skill via {dirname}.md fallback", async () => {
    const pluginDir = join(tmp, "cache", "my-plugin");
    // No SKILL.md, but has deploy/deploy.md
    const skillDir = join(pluginDir, "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "deploy.md"), "---\ndescription: deploy tool\n---\nDeploy it");

    writePluginsJson(configDir, {
      "my-plugin@test": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const match = skills.find((s) => s.name === "deploy");
    expect(match).toBeDefined();
    expect(match!.description).toBe("deploy tool");
  });

  it("discovers skills via recursive directory traversal", async () => {
    const pluginDir = join(tmp, "cache", "my-plugin");
    // Nested: skills/namespace/inner/SKILL.md (no SKILL.md or dirname.md at namespace level)
    writeSkill(join(pluginDir, "skills", "ns", "inner"), "---\ndescription: nested\n---\nNested skill");

    writePluginsJson(configDir, {
      "my-plugin@test": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const match = skills.find((s) => s.name === "ns/inner");
    expect(match).toBeDefined();
    expect(match!.description).toBe("nested");
  });

  it("discovers top-level .md files as skills", async () => {
    const pluginDir = join(tmp, "cache", "my-plugin");
    const skillsDir = join(pluginDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "quick.md"), "---\ndescription: quick skill\n---\nDo quick thing");
    // Non-md file should be ignored
    writeFileSync(join(skillsDir, "readme.txt"), "not a skill");

    writePluginsJson(configDir, {
      "my-plugin@test": { installPath: pluginDir },
    });

    const skills = await discoverSkills(projectDir);
    const names = skills.map((s) => s.name);
    expect(names).toContain("quick");
    expect(names).not.toContain("readme");
  });

  it("strips marketplace suffix from plugin key for root skill name", async () => {
    const dir1 = join(tmp, "cache", "search");
    writeSkill(dir1, "---\ndescription: search\n---\nSearch");
    const dir2 = join(tmp, "cache", "summary");
    writeSkill(dir2, "---\ndescription: summary\n---\nSummary");

    writePluginsJson(configDir, {
      "search@melten-docs": { installPath: dir1 },
      "summary@melten-docs": { installPath: dir2 },
    });

    const skills = await discoverSkills(projectDir);
    const names = skills.map((s) => s.name);
    expect(names).toContain("search");
    expect(names).toContain("summary");
  });
});
