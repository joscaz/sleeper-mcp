import { afterEach, describe, expect, it } from "vitest";
import { connectedClient } from "./helpers.js";
import {
  LEAGUE_ID, SCHEDULE_URL, league, matchupsWeek5, liveMatchupsWeek5, liveStatsWeek5,
  preKickoffSchedule2026, schedule2026, rosters, projectionsWeek5, state,
} from "./fixtures.js";
import { SleeperGraphqlClient } from "../src/sleeper/graphql.js";

type Connected = Awaited<ReturnType<typeof connectedClient>>;
let c: Connected | undefined;
afterEach(async () => { await c?.close(); c = undefined; });

const upcoming = matchupsWeek5.map((m) => ({ ...m, points: 0, players_points: {} }));
const current = [...rosters[0]!.starters!];
const laporta = { name: "LaPorta", moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] };
const taylor = { name: "Taylor", moves: [{ start: "Jonathan Taylor", bench: "Breece Hall" }] };

async function setup(routes: Record<string, unknown> = {}, options: Parameters<typeof connectedClient>[1] = {}) {
  c = await connectedClient({
    [SCHEDULE_URL]: preKickoffSchedule2026,
    [`/league/${LEAGUE_ID}/matchups/5`]: upcoming,
    ...routes,
  }, { defaultUser: "alice", ...options });
  return c;
}

async function compare(scenarios: unknown[]) {
  const result = await c!.call("compare_lineups", { league_id: LEAGUE_ID, scenarios });
  expect(result.result.isError, result.text).toBeFalsy();
  return result.data as {
    baseline: { projected_total: number; points_so_far: number; win_pct: number | null; starters: { id: string; locked: boolean; points_so_far: number }[] };
    opponent: { projected_total: number } | null;
    odds_unavailable_reason: string | null;
    scenarios: { name: string; valid: boolean; error?: string; projected_total: number; projected_points_delta: number; win_pct: number | null; win_probability_delta_pp: number | null; changes: string[]; starters: { id: string }[]; warnings: string[] }[];
    injury_context: { id: string; injury_context: { needs_check: boolean } }[];
    snapshot: { lineup_source: string };
  };
}

describe("compare_lineups", () => {
  it("compares independent scenarios with resolved names and one set of fetched inputs", async () => {
    const { ff } = await setup();
    const before = structuredClone({ upcoming, rosters });
    const result = await compare([laporta, taylor]);
    expect(result.scenarios.every((s) => s.valid)).toBe(true);
    const [te, rb] = result.scenarios;
    expect(te!.starters[5]!.id).toBe("9509");
    expect(rb!.starters[5]!.id).toBe("5850"); // not chained from the LaPorta scenario
    expect(rb!.starters[2]!.id).toBe("6813");
    expect(te!.projected_points_delta).toBe(10.6);
    expect(te!.changes).toEqual(["TE: Travis Kelce (TE, KC) → Sam LaPorta (TE, DET)"]);
    expect(result.snapshot.lineup_source).toBe("public_weekly_matchups");
    for (const path of [`/league/${LEAGUE_ID}/matchups/5`, "/projections/nfl/regular/2026/5", SCHEDULE_URL]) {
      expect(ff.calls.filter((p) => p === path)).toHaveLength(1);
    }
    expect({ upcoming, rosters }).toEqual(before);
  });

  it("returns exact zero deltas for an unchanged lineup", async () => {
    await setup();
    const result = await compare([{ name: "Same", starters: current }]);
    expect(result.scenarios[0]).toMatchObject({
      valid: true, changes: [], projected_points_delta: 0, win_probability_delta_pp: 0,
      projected_total: result.baseline.projected_total, win_pct: result.baseline.win_pct,
    });
  });

  it("matches the existing matchup-odds model for the baseline", async () => {
    const { call } = await setup();
    const result = await compare([laporta]);
    const odds = await call("get_matchup_odds", { league_id: LEAGUE_ID, username: "alice" });
    const teams = (odds.data!.matchups as { teams: { roster_id: number; projected: number; win_pct: number }[] }[])[0]!.teams;
    expect(result.baseline.win_pct).toBe(teams.find((t) => t.roster_id === 1)!.win_pct);
    expect(result.baseline.projected_total).toBeCloseTo(teams.find((t) => t.roster_id === 1)!.projected, 0);
    expect(result.scenarios[0]!.win_pct).toBeGreaterThanOrEqual(result.baseline.win_pct!);
  });

  it("uses exact league scoring rather than built-in PPR totals", async () => {
    await setup({
      [`/league/${LEAGUE_ID}`]: { ...league, scoring_settings: { rec: 0.5, rec_yd: 0.1 } },
      "/projections/nfl/regular/2026/5": {
        "8138": { rec: 3, rec_yd: 40, pts_ppr: 999 },
        "6813": { rec: 5, rec_yd: 60, pts_ppr: 999 },
      },
    });
    expect((await compare([taylor])).scenarios[0]!.projected_points_delta).toBe(3);
  });

  it("starts from weekly starters, not roster defaults", async () => {
    const weekly = current.map((id) => id === "5850" ? "9509" : id);
    await setup({ [`/league/${LEAGUE_ID}/matchups/5`]: upcoming.map((m) => m.roster_id === 1 ? { ...m, starters: weekly } : m) });
    const result = await compare([{ name: "Keep current", starters: weekly }]);
    expect(result.baseline.starters[5]!.id).toBe("9509");
    expect(result.scenarios[0]!.projected_points_delta).toBe(0);
  });

  it.each([
    { name: "Wrong slot", moves: [{ start: "Sam LaPorta", bench: "Patrick Mahomes" }], error: /cannot start at QB/ },
    { name: "Not rostered", moves: [{ start: "Josh Allen", bench: "Patrick Mahomes" }], error: /not on this roster/ },
    { name: "Not a starter", moves: [{ start: "Sam LaPorta", bench: "Jonathan Taylor" }], error: /not currently starting/ },
    { name: "Wrong length", starters: ["Patrick Mahomes"], error: /9 starting slots/ },
    { name: "Duplicate", starters: current.map((id) => id === "8138" ? "9226" : id), error: /appears twice/ },
  ])("isolates the $name error while preserving valid results", async ({ error, ...scenario }) => {
    await setup();
    const result = await compare([scenario, laporta]);
    expect(result.scenarios[0]).toMatchObject({ valid: false, error: expect.stringMatching(error) });
    expect(result.scenarios[1]!.valid).toBe(true);
  });

  it.each(["reserve", "taxi"])("rejects a candidate on %s", async (field) => {
    await setup({ [`/league/${LEAGUE_ID}/rosters`]: rosters.map((r) => r.roster_id === 1 ? { ...r, [field]: ["9509"] } : r) });
    expect((await compare([laporta])).scenarios[0]).toMatchObject({ valid: false, error: expect.stringMatching(/IR|taxi/) });
  });

  it("respects a WR/RB-only FLEX slot", async () => {
    await setup({ [`/league/${LEAGUE_ID}`]: { ...league, roster_positions: league.roster_positions.map((slot) => slot === "FLEX" ? "WRRB_FLEX" : slot) } });
    const result = await compare([{ name: "TE in FLEX", moves: [{ start: "Sam LaPorta", bench: "Drake London" }] }]);
    expect(result.scenarios[0]).toMatchObject({ valid: false, error: expect.stringMatching(/cannot start at WRRB_FLEX/) });
  });

  it.each([
    { team: "KC", scenario: laporta },
    { team: "IND", scenario: taylor },
  ])("rejects moving a locked starter or bench player from $team", async ({ team, scenario }) => {
    await setup({ [SCHEDULE_URL]: preKickoffSchedule2026.map((g) => [g.home, g.away].includes(team) ? { ...g, status: "complete" } : g) });
    expect((await compare([scenario])).scenarios[0]).toMatchObject({ valid: false, error: expect.stringMatching(/locked/) });
  });

  it("preserves live/scored points and locked players when other slots change", async () => {
    await setup({
      [SCHEDULE_URL]: schedule2026,
      [`/league/${LEAGUE_ID}/matchups/5`]: liveMatchupsWeek5,
      "/stats/nfl/regular/2026/5": liveStatsWeek5,
    });
    const result = await compare([{ name: "Swap WR slots", moves: [{ start: "Justin Jefferson", bench: "Ja'Marr Chase" }] }]);
    expect(result.scenarios[0]!.valid).toBe(true);
    expect(result.scenarios[0]!.projected_points_delta).toBe(0);
    expect(result.baseline.points_so_far).toBe(liveMatchupsWeek5[0]!.points);
    expect(result.baseline.starters[0]).toMatchObject({ id: "4046", locked: true, points_so_far: 24.1 });
    expect(result.scenarios[0]!.starters[0]!.id).toBe("4046");
  });

  it("shows injury warnings without turning Questionable into Out", async () => {
    await setup();
    const result = await compare([taylor]);
    expect(result.scenarios[0]!.valid).toBe(true);
    expect(result.scenarios[0]!.warnings.join(" ")).toMatch(/Jonathan Taylor.*Questionable/);
    expect(result.injury_context.find((p) => p.id === "6813")?.injury_context.needs_check).toBe(true);
  });

  it("warns about a missing candidate projection instead of inventing one", async () => {
    const projection = { ...projectionsWeek5 };
    delete projection["9509"];
    await setup({ "/projections/nfl/regular/2026/5": projection });
    expect((await compare([laporta])).scenarios[0]!.warnings.join(" ")).toMatch(/Sam LaPorta: no Sleeper projection/);
  });

  it("keeps point comparisons but does not invent odds without an opponent", async () => {
    await setup({ [`/league/${LEAGUE_ID}/matchups/5`]: upcoming.map((m) => m.roster_id === 1 ? { ...m, matchup_id: null } : m) });
    const result = await compare([laporta]);
    expect(result.opponent).toBeNull();
    expect(result.baseline.win_pct).toBeNull();
    expect(result.scenarios[0]).toMatchObject({ valid: true, win_pct: null, win_probability_delta_pp: null, projected_points_delta: 10.6 });
    expect(result.odds_unavailable_reason).toMatch(/No single head-to-head/);
  });

  it("does not fabricate odds for an unpopulated opponent lineup", async () => {
    await setup({ [`/league/${LEAGUE_ID}/matchups/5`]: upcoming.map((m) => m.roster_id === 2 ? { ...m, starters: [] } : m) });
    expect((await compare([laporta])).odds_unavailable_reason).toMatch(/no populated/);
  });

  it("rejects duplicate starters in the source lineup rather than double-counting points", async () => {
    const { call } = await setup({
      [`/league/${LEAGUE_ID}/matchups/5`]: upcoming.map((m) => m.roster_id === 1 ? { ...m, starters: current.map((id) => id === "8138" ? "9226" : id) } : m),
    });
    const result = await call("compare_lineups", { league_id: LEAGUE_ID, scenarios: [laporta] });
    expect(result.result.isError).toBe(true);
    expect(result.text).toMatch(/contain duplicates/);
  });

  it("honors commissioner score overrides", async () => {
    await setup({ [`/league/${LEAGUE_ID}/matchups/5`]: upcoming.map((m) => m.roster_id === 1 ? { ...m, custom_points: 80 } : m) });
    const result = await compare([laporta]);
    expect(result.baseline.projected_total).toBe(80);
    expect(result.scenarios[0]).toMatchObject({ projected_total: 80, projected_points_delta: 0, win_probability_delta_pp: 0 });
    expect(result.scenarios[0]!.warnings.join(" ")).toMatch(/custom_points/);
  });

  it("never calls account APIs even when a session is available", async () => {
    let accountCalls = 0;
    const auth = new SleeperGraphqlClient({ token: "test-only", fetch: (async () => { accountCalls++; throw new Error("Unexpected account API call"); }) as typeof fetch });
    const { client } = await setup({}, { auth });
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "compare_lineups")?.annotations?.readOnlyHint).toBe(true);
    await compare([laporta, taylor]);
    expect(accountCalls).toBe(0);
  });

  it.each([
    { routes: { [SCHEDULE_URL]: () => ({ status: 503 }) }, message: /NFL schedule/ },
    { routes: { "/projections/nfl/regular/2026/5": {} }, message: /No projections/ },
    { routes: { [`/league/${LEAGUE_ID}/matchups/5`]: [] }, message: /No unambiguous weekly/ },
    { routes: { "/state/nfl": { ...state, season_type: "pre" } }, message: /current regular-season/ },
    { routes: { [`/league/${LEAGUE_ID}`]: { ...league, settings: { ...league.settings, best_ball: 1 } } }, message: /Best-ball/ },
  ])("fails clearly when the comparison has insufficient or unsupported data", async ({ routes, message }) => {
    const { call } = await setup(routes);
    const result = await call("compare_lineups", { league_id: LEAGUE_ID, scenarios: [laporta] });
    expect(result.result.isError).toBe(true);
    expect(result.text).toMatch(message);
  });

  it("requires unique scenario labels and exactly one input form", async () => {
    const { call } = await setup();
    for (const scenarios of [[laporta, laporta], [{ name: "Empty" }], [{ ...laporta, starters: current }], Array.from({ length: 6 }, (_, i) => ({ ...laporta, name: String(i) }))]) {
      expect((await call("compare_lineups", { league_id: LEAGUE_ID, scenarios })).result.isError).toBe(true);
    }
  });
});
