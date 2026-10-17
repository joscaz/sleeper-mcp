import { afterEach, describe, expect, it } from "vitest";
import { EspnInjuryFeed, ESPN_INJURIES_URL, parseInjuries, type InjuryFeed, type InjuryItem } from "../src/injuries/espn.js";
import { InjuryContextService, matchInjuries } from "../src/injuries/context.js";
import { PlayerStore } from "../src/sleeper/players.js";
import { connectedClient, fakeFetch, testClient } from "./helpers.js";
import { LEAGUE_ID, SCHEDULE_URL, players, preKickoffSchedule2026, matchupsWeek5 } from "./fixtures.js";

const now = Date.parse("2026-10-17T18:00:00Z");
const item = (overrides: Partial<InjuryItem> = {}): InjuryItem => ({
  athleteId: "123", name: "Travis Kelce", team: "KC", position: "TE", designation: "Out",
  reportedAt: "2026-10-17T17:00:00.000Z", bodyPart: "Knee", note: "Synthetic report.",
  url: "https://www.espn.com/nfl/player/_/id/123/test-player", ...overrides,
});
const feedBody = (status = "Out") => ({
  status: "success", timestamp: "2026-10-17T17:59:00Z", injuries: [{
    injuries: [{
      status, date: "2026-10-17T17:00:00Z", shortComment: "Synthetic report.", details: { type: "Knee" },
      athlete: { displayName: "Travis Kelce", team: { abbreviation: "KC" }, position: { abbreviation: "TE" },
        links: [{ href: "https://www.espn.com/nfl/player/_/id/123/test-player" }] },
    }],
  }],
});
const fakeFeed = (items: InjuryItem[], expiresAt = Date.now() + 300_000): InjuryFeed => ({
  get: async () => ({ snapshot: { items, retrievedAt: Date.now(), expiresAt, feedUpdatedAt: null }, error: null }),
});
let connection: Awaited<ReturnType<typeof connectedClient>> | undefined;
afterEach(async () => { await connection?.close(); connection = undefined; });

async function service(feed: InjuryFeed | null, clock = () => now) {
  const store = new PlayerStore(testClient(), { cacheDir: null, now: clock });
  await store.ensureLoaded();
  return { store, injuries: new InjuryContextService(store, feed, clock) };
}

describe("ESPN injury adapter", () => {
  it("parses identity, source links and report timestamps without treating the injury record ID as a player ID", () => {
    const body = feedBody();
    const parsed = parseInjuries(body);
    expect(parsed.items[0]).toMatchObject({ athleteId: "123", name: "Travis Kelce", reportedAt: "2026-10-17T17:00:00.000Z", designation: "Out" });
    body.injuries[0]!.injuries[0]!.athlete.team.abbreviation = "WSH";
    expect(parseInjuries(body).items[0]!.team).toBe("WAS");
  });

  it("rejects malformed responses instead of returning a falsely empty report", () => {
    for (const body of [null, {}, { injuries: null }, { status: "error", injuries: [] }, { injuries: [{}] }, { injuries: [{ injuries: [{}] }] }]) {
      expect(() => parseInjuries(body)).toThrow(/Unexpected ESPN/);
    }
  });

  it("does not trust off-site or non-HTTPS player links", () => {
    const body = feedBody();
    body.injuries[0]!.injuries[0]!.athlete.links = [{ href: "https://example.com/nfl/player/_/id/123/test" }];
    expect(parseInjuries(body).items[0]!.athleteId).toBeNull();
    expect(parseInjuries(body).items[0]!.url).toBeNull();
  });

  it("deduplicates concurrent requests and respects the configured cache", async () => {
    let time = now, requests = 0;
    const feed = new EspnInjuryFeed({ now: () => time, ttlMs: 1000, fetch: (async (url, options) => {
      requests++;
      expect(url).toBe(ESPN_INJURIES_URL);
      expect(options?.headers).toEqual({ accept: "application/json" });
      return new Response(JSON.stringify(feedBody()));
    }) as typeof fetch });
    const [a, b] = await Promise.all([feed.get(), feed.get()]);
    expect(requests).toBe(1); expect(a.snapshot).toBe(b.snapshot);
    await feed.get(); expect(requests).toBe(1);
    time += 1001; await feed.get(); expect(requests).toBe(2);
  });

  it("retains the old fetch time after a failed refresh and backs off", async () => {
    let time = now, requests = 0;
    const feed = new EspnInjuryFeed({ now: () => time, ttlMs: 1000, fetch: (async () => {
      requests++;
      return requests === 1 ? new Response(JSON.stringify(feedBody())) : new Response("unavailable", { status: 503 });
    }) as typeof fetch });
    await feed.get(); time += 1001;
    const failed = await feed.get();
    expect(failed.error).toMatch(/503/);
    expect(failed.snapshot?.retrievedAt).toBe(now);
    expect(failed.snapshot!.expiresAt).toBeLessThan(time);
    await feed.get(); expect(requests).toBe(2);
  });

  it("honors Retry-After and does not need a previous snapshot to fail gracefully", async () => {
    let time = now, requests = 0;
    const feed = new EspnInjuryFeed({ now: () => time, ttlMs: 1000, fetch: (async () => {
      requests++; return new Response("", { status: 429, headers: { "retry-after": "10" } });
    }) as typeof fetch });
    expect((await feed.get()).snapshot).toBeNull();
    time += 2000; await feed.get(); expect(requests).toBe(1);
    time += 8001; await feed.get(); expect(requests).toBe(2);
  });

  it("bounds network waits and returns an unavailable result", async () => {
    const feed = new EspnInjuryFeed({ timeoutMs: 5, fetch: (async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch });
    expect(await feed.get()).toMatchObject({ snapshot: null, error: expect.stringMatching(/unavailable or timed out/) });
  });
});

describe("injury identity and evidence", () => {
  it("matches a unique exact name/team/position when the Sleeper ESPN ID is missing", () => {
    expect(matchInjuries([item()], [{ ...players["5850"]!, espn_id: null }]).matched.get("5850")?.name).toBe("Travis Kelce");
  });

  it("rejects ambiguous identity and never guesses from partial names", () => {
    const candidates = [players["5850"]!, { ...players["5850"]!, player_id: "duplicate" }];
    const ambiguous = matchInjuries([item()], candidates);
    expect(ambiguous.matched.size).toBe(0); expect(ambiguous.ambiguous.size).toBe(2);
    expect(matchInjuries([item({ name: "T. Kelce" })], [players["5850"]!]).matched.size).toBe(0);
  });

  it("requires ID matches to agree with name, team and position", () => {
    const p = { ...players["5850"]!, espn_id: 123 };
    expect(matchInjuries([item({ team: "NYG" })], [p]).matched.size).toBe(0);
    expect(matchInjuries([item({ position: "WR" })], [p]).matched.size).toBe(0);
  });

  it("chooses the latest dated report but preserves ambiguous same-time conflicts", () => {
    const old = item({ designation: "Questionable", reportedAt: "2026-10-16T17:00:00Z" });
    expect(matchInjuries([old, item()], [players["5850"]!]).matched.get("5850")?.designation).toBe("Out");
    expect(matchInjuries([item({ designation: "Questionable" }), item()], [players["5850"]!]).ambiguous.has("5850")).toBe(true);
  });

  it("keeps source report time separate from retrieval time", async () => {
    const feed: InjuryFeed = { get: async () => ({ snapshot: { items: [item()], retrievedAt: now, expiresAt: now + 1000, feedUpdatedAt: null }, error: null }) };
    const { injuries } = await service(feed);
    const report = (await injuries.report(["5850"])).byPlayer.get("5850")!;
    expect(report.reports[0]).toMatchObject({ source: "sleeper", reported_at: null, retrieved_at: new Date(now).toISOString() });
    expect(report.reports[1]).toMatchObject({ source: "espn", reported_at: item().reportedAt, retrieved_at: new Date(now).toISOString() });
  });

  it("does not silently clear a Sleeper flag when ESPN says Active", async () => {
    const { injuries } = await service(fakeFeed([item({ designation: null })]));
    const context = (await injuries.report(["5850"])).byPlayer.get("5850")!;
    expect(context).toMatchObject({ conflict: true, source: "conflict", designation: null, needs_check: true });
    expect(context.reports.map((r) => r.designation)).toEqual(["Out", null]);
  });

  it("does not equate absence from the ESPN feed with health", async () => {
    const { injuries } = await service(fakeFeed([]));
    expect((await injuries.report(["5850"])).byPlayer.get("5850")).toMatchObject({ designation: "Out", source: "sleeper", espn_match: "not_listed" });
  });

  it("reports source failures without breaking the Sleeper result", async () => {
    const { injuries } = await service({ get: async () => { throw new Error("failure"); } });
    const result = await injuries.report(["5850"]);
    expect(result.source_status).toBe("unavailable");
    expect(result.byPlayer.get("5850")?.designation).toBe("Out");
    expect(result.warning).toMatch(/unavailable/);
  });

  it("marks expired ESPN snapshots stale without rewriting their retrieval timestamp", async () => {
    const feed: InjuryFeed = { get: async () => ({ snapshot: { items: [item()], retrievedAt: now - 2000, expiresAt: now - 1000, feedUpdatedAt: null }, error: "Refresh failed." }) };
    const { injuries } = await service(feed);
    const result = await injuries.report(["5850"]);
    expect(result.source_status).toBe("stale");
    expect(result.byPlayer.get("5850")?.reports[1]).toMatchObject({ stale: true, retrieved_at: new Date(now - 2000).toISOString() });
    expect(result.byPlayer.get("5850")?.needs_check).toBe(true);
  });
});

describe("injury tools and lineup watchlist", () => {
  it("enriches player details and reports without enabling any writes", async () => {
    connection = await connectedClient({}, { injuryFeed: fakeFeed([item()]) });
    const detail = await connection.call("get_player", { player_id: "5850" });
    expect(detail.data?.injury_context).toMatchObject({ source: "espn" });
    const report = await connection.call("get_injury_report", { player_ids: ["5850", "unknown"] });
    expect(report.data).toMatchObject({ count: 1, unknown_player_ids: ["unknown"] });
    const tools = (await connection.client.listTools()).tools;
    expect(tools.find((t) => t.name === "get_injury_report")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.some((t) => t.name === "set_lineup")).toBe(false);
  });

  it("supports roster selection and Sleeper-only mode", async () => {
    connection = await connectedClient({}, { defaultUser: "alice" });
    const report = await connection.call("get_injury_report", { league_id: LEAGUE_ID });
    expect(report.result.isError).toBeFalsy();
    expect(report.data?.injury_data).toMatchObject({ status: "disabled" });
    expect(report.data?.count).toBe(11);
    expect((await connection.call("get_injury_report", {})).result.isError).toBe(true);
  });

  it("puts questionable starters on a watchlist, not in injury-driven lineup moves", async () => {
    const starters = matchupsWeek5[0]!.starters!.map((id) => id === "8138" ? "6813" : id === "5850" ? "9509" : id);
    connection = await connectedClient({
      [SCHEDULE_URL]: preKickoffSchedule2026,
      [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5.map((m) => m.roster_id === 1 ? { ...m, starters } : m),
    });
    const result = await connection.call("check_lineups", { username: "alice" });
    expect(result.data).toMatchObject({ at_risk: 1, needs_fix: 0, needs_check: 1 });
    const report = (result.data!.leagues as Record<string, unknown>[])[0]!;
    expect(report.set_lineup).toBeUndefined();
    expect(report.problems).toBeUndefined();
    expect(report.needs_check).toEqual([expect.objectContaining({ player: expect.objectContaining({ id: "6813" }) })]);
  });

  it("does not generate an injury move from conflicting reports", async () => {
    connection = await connectedClient({ [SCHEDULE_URL]: preKickoffSchedule2026 }, { injuryFeed: fakeFeed([item({ designation: null })]) });
    const result = await connection.call("check_lineups", { username: "alice" });
    const report = (result.data!.leagues as Record<string, unknown>[])[0]!;
    expect(report.set_lineup).toBeUndefined();
    expect(report.needs_check).toEqual([expect.objectContaining({ injury_context: expect.objectContaining({ conflict: true }) })]);
  });

  it("includes current injury evidence alongside unchanged Sleeper projections", async () => {
    connection = await connectedClient({ [SCHEDULE_URL]: preKickoffSchedule2026 }, { injuryFeed: fakeFeed([item({ designation: null })]) });
    const result = await connection.call("get_lineup_projections", { league_id: LEAGUE_ID, username: "alice" });
    expect(result.result.isError).toBeFalsy();
    expect(result.data?.injury_data).toMatchObject({ status: "available", note: expect.stringContaining("still use Sleeper data") });
    expect(result.data?.needs_check).toEqual(expect.arrayContaining([expect.objectContaining({ injury_context: expect.objectContaining({ conflict: true }) })]));
  });

  it("keeps basic player reads working during an optional-source outage", async () => {
    connection = await connectedClient({}, { injuryFeed: { get: async () => { throw new Error("down"); } } });
    const result = await connection.call("get_player", { player_id: "5850" });
    expect(result.result.isError).toBeFalsy();
    expect(result.data?.injury_data).toMatchObject({ status: "unavailable", warning: expect.stringMatching(/unavailable/) });
  });
});
