import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("source-first distribution", () => {
  it("keeps the npm publication guard enabled", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.prepublishOnly).toBeUndefined();
  });

  it("prepares only a draft GitHub release from an existing tag", () => {
    const workflow = read(".github/workflows/release.yml");
    const releaseCommand = workflow.split("\n").find((line) => line.includes("run: gh release create"));
    expect(releaseCommand).toBeDefined();
    expect(releaseCommand).toContain("--draft");
    expect(releaseCommand).toContain("--verify-tag");
    expect(workflow).not.toMatch(/npm\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|id-token:\s*write|registry-url:/);
  });

  it("documents a built local server instead of an unpublished npm package", () => {
    const readme = read("README.md");
    expect(readme).not.toMatch(/npx[^\n]*@joscaz\/sleeper-mcp|img\.shields\.io\/npm/);
    const configs = [...readme.matchAll(/```json\n([\s\S]*?)```/g)];
    const config = configs.map((match) => JSON.parse(match[1]!)).find((entry) => entry.mcpServers?.sleeper);
    expect(config).toBeDefined();
    expect(config.mcpServers.sleeper.command).toBe("node");
    expect(config.mcpServers.sleeper.args).toEqual(["/absolute/path/to/sleeper-mcp/dist/index.js", "--read-only"]);
  });
});
