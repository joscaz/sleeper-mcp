import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlayerStore, normalizeName } from "../src/sleeper/players.js";
import { fakeFetch, testClient } from "./helpers.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function store(ff = fakeFetch(), cacheDir: string | null = null, now?: () => number) {
  const s = new PlayerStore(testClient(ff), { cacheDir, now });
  await s.ensureLoaded();
  return s;
}

describe("PlayerStore", () => {
  it("resolves ids to compact refs, including team defenses and unknown ids", async () => {
    const s = await store();
    expect(s.ref("4046")).toEqual({ id: "4046", name: "Patrick Mahomes", pos: "QB", team: "KC" });
    expect(s.ref("6813")).toMatchObject({ name: "Jonathan Taylor", inj: "Questionable" });
    expect(s.ref("DET")).toMatchObject({ name: "Detroit Lions", pos: "DEF", team: "DET" });
    expect(s.ref("NYG")).toEqual({ id: "NYG", name: "New York Giants", pos: "DEF", team: "NYG" });
    expect(s.ref("999999")).toEqual({ id: "999999", name: "999999", pos: null, team: null });
    expect(s.label("7564")).toBe("Ja'Marr Chase (WR, CIN)");
  });

  it("searches by name with exact > prefix > substring ranking", async () => {
    const s = await store();
    expect(s.search("mahomes").map((p) => p.player_id)).toEqual(["4046"]);
    expect(s.search("ja marr")[0]?.player_id).toBe("7564");
    expect(s.search("JEFFERSON")[0]?.player_id).toBe("6794");
    expect(s.search("lions")[0]?.player_id).toBe("DET");
    // "j" prefix-matches several; ordering follows search_rank.
    const js = s.search("j", { limit: 3 }).map((p) => p.player_id);
    expect(js[0]).toBe("7564"); // Ja'Marr Chase rank 2
    expect(s.search("nobody-here")).toEqual([]);
  });

  it("filters by position, team and active status", async () => {
    const s = await store();
    expect(s.search("", { position: "QB" }).map((p) => p.player_id)).toEqual(["4984", "4046", "11002"]);
    expect(s.search("", { team: "KC" }).map((p) => p.player_id)).toEqual(["4046", "5850", "4195"]);
    expect(s.search("ron", { activeOnly: true })).toEqual([]);
    expect(s.search("ron", { activeOnly: false }).map((p) => p.player_id)).toEqual(["11004"]);
  });

  it("persists to disk and reuses the cache on the next start", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sleeper-mcp-test-"));
    tmpDirs.push(dir);
    const ff = fakeFetch();
    await store(ff, dir);
    const file = path.join(dir, "players-nfl.json");
    const saved = JSON.parse(await readFile(file, "utf8")) as { savedAt: number; players: Record<string, unknown> };
    expect(Object.keys(saved.players)).toContain("4046");

    const ff2 = fakeFetch();
    const s2 = await store(ff2, dir);
    expect(s2.count).toBeGreaterThan(0);
    expect(ff2.calls).not.toContain("/players/nfl");

    // Expired cache triggers a re-download.
    const ff3 = fakeFetch();
    await store(ff3, dir, () => saved.savedAt + 48 * 60 * 60_000);
    expect(ff3.calls).toContain("/players/nfl");
  });

  it("falls back to a stale disk cache when the download fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sleeper-mcp-test-"));
    tmpDirs.push(dir);
    await store(fakeFetch(), dir);
    const failing = fakeFetch({ "/players/nfl": () => ({ status: 500 }) });
    const s = new PlayerStore(testClient(failing), { cacheDir: dir, now: () => Date.now() + 72 * 60 * 60_000 });
    await s.ensureLoaded();
    expect(s.ref("4046").name).toBe("Patrick Mahomes");
  });

  it("normalizes names", () => {
    expect(normalizeName("Ja'Marr Chase")).toBe("jamarrchase");
    expect(normalizeName("  D.J. Moore ")).toBe("djmoore");
    expect(normalizeName("José Ramírez")).toBe("joseramirez");
  });
});
