import { describe, expect, it } from "vitest";
import { parseUsageRows, playerUsageWeeks, teamTotals, usageTrend, usageWindow, type UsageWeek } from "../src/usage.js";
import type { ScheduleGame } from "../src/sleeper/types.js";
import { connectedClient } from "./helpers.js";
import { state } from "./fixtures.js";

const schedule: ScheduleGame[] = [1, 2, 3, 4].flatMap(week => [
  { game_id: `kc-${week}`, week, date: null, home: "KC", away: "BUF", status: "complete" },
  { game_id: `atl-${week}`, week, date: null, home: "ATL", away: "NYJ", status: "complete" },
]);
const games = (week: number) => schedule.filter(g => g.week === week);
function row(week: number, player_id = "5850", team = "KC", stats: Record<string, unknown> = { off_snp: 30, tm_off_snp: 60, rec_tgt: week * 2 }) {
  return {
    player_id, team, stats, game_id: `${team === "KC" ? "kc" : "atl"}-${week}`,
    season: "2026", season_type: "regular", sport: "nfl", week,
    updated_at: Date.parse("2026-10-01T00:00:00Z"),
    player: { first_name: "Example", last_name: player_id, position: "TE" },
  };
}
function rows(week: number) {
  return [
    row(week), row(week, "4046", "KC", { off_snp: 60, tm_off_snp: 60, rush_att: 4 }),
    row(week, "9509", "KC", { off_snp: 30, tm_off_snp: 60, rec_tgt: 10 - week * 2 }),
    row(week, "9226", "ATL", { off_snp: 40, tm_off_snp: 60, rush_att: 20 }),
  ];
}
function statUrl(week: number, season = "2026") {
  return `https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE`;
}
function routes() {
  return {
    "https://api.sleeper.app/schedule/nfl/regular/2026": schedule,
    ...Object.fromEntries([1, 2, 3, 4].map(w => [statUrl(w), rows(w)])),
  };
}
function dataWeek(week: number, values: unknown = rows(week)): UsageWeek {
  return { week, games: games(week), rows: parseUsageRows(values, "2026", week, games(week)), status: "available", reason: null };
}

describe("usage row validation", () => {
  it("retains historical team, source update and identity", () => {
    const parsed = parseUsageRows([row(1)], "2026", 1, games(1));
    expect(parsed[0]).toMatchObject({ team: "KC", player_id: "5850", name: "Example 5850", updated_at: Date.parse("2026-10-01T00:00:00Z") });
  });
  it.each([
    null, {}, [null], [{ ...row(1), stats: null }], [{ ...row(1), stats: [] }],
    [{ ...row(1), season: "2025" }], [{ ...row(1), week: 2 }],
    [{ ...row(1), season_type: "post" }], [{ ...row(1), sport: "nba" }],
    [{ ...row(1), team: "DET" }], [{ ...row(1), game_id: "wrong" }],
    [{ ...row(1), player_id: "" }],
    [row(1, "5850", "KC", { off_snp: null })],
    [row(1, "5850", "KC", { off_snp: "30" })],
    [row(1, "5850", "KC", { off_snp: NaN })],
    [row(1, "5850", "KC", { rec_tgt: -1 })],
    [row(1), row(1)],
  ].map(value => ({ value })))("rejects malformed/inconsistent rows rather than computing partial totals (%#)", ({ value }) => {
    expect(() => parseUsageRows(value, "2026", 1, games(1))).toThrow();
  });
});

describe("descriptive usage calculations", () => {
  it("computes shares, zero sparse counts on played rows, and actual per-metric samples", () => {
    const history = playerUsageWeeks([1, 2, 3, 4].map(w => dataWeek(w)), "5850");
    expect(history[0]).toMatchObject({
      status: "played", team: "KC", team_basis: "stat_row",
      denominators: { targets: 10, carries: 4, row_count: 3, team_offensive_snaps: 60 },
      metrics: { off_snp: 30, rec_tgt: 2, rush_att: 0, snap_share: 50, target_share: 20, carry_share: 0, red_zone_share: null },
    });
    expect(usageTrend(history)).toMatchObject({
      played_weeks: 4, baseline_weeks: [1, 2], recent_weeks: [3, 4], status: "descriptive_only",
      metrics: {
        target_share: { baseline: { mean: 30, samples: 2 }, recent: { mean: 70, samples: 2 }, delta: 40, delta_unit: "percentage_points" },
        rec_tgt: { delta: 4, delta_unit: "per_played_week" },
        red_zone_share: { baseline: { mean: null, samples: 0 }, recent: { mean: null, samples: 0 }, delta: null },
      },
    });
  });
  it("uses last versus first with two played weeks, never a predictive label", () => {
    const trend = usageTrend(playerUsageWeeks([dataWeek(1), dataWeek(2)], "5850"));
    expect(trend).toMatchObject({ baseline_weeks: [1], recent_weeks: [2], metrics: { target_share: { delta: 20 } } });
    expect(trend).not.toHaveProperty("label");
  });
  it("combines red-zone targets and carries, with null shares for zero-volume denominators", () => {
    const w = dataWeek(1, [
      row(1, "5850", "KC", { off_snp: 30, rec_rz_tgt: 2, rush_rz_att: 1 }),
      row(1, "4046", "KC", { off_snp: 30, rush_rz_att: 3 }),
    ]);
    expect(playerUsageWeeks([w], "5850")[0]!.metrics).toMatchObject({
      red_zone_share: 50, target_share: null, carry_share: null, air_yard_share: null,
    });
  });
  it("counts available samples separately for each metric without shifting the comparison windows", () => {
    const first = dataWeek(1, [row(1, "5850", "KC", { off_snp: 30 })]);
    const history = playerUsageWeeks([first, dataWeek(2), dataWeek(3), dataWeek(4)], "5850");
    expect(usageTrend(history).metrics.snap_share).toMatchObject({
      baseline: { mean: 50, samples: 1 }, recent: { mean: 50, samples: 2 }, delta: 0,
    });
  });
  it("does not manufacture a baseline with one played week", () => {
    expect(usageTrend(playerUsageWeeks([dataWeek(1)], "5850"))).toMatchObject({
      status: "insufficient_sample", played_weeks: 1, baseline_weeks: [],
      metrics: { target_share: { delta: null, baseline: { samples: 0 }, recent: { samples: 1 } } },
    });
  });
  it("distinguishes no offensive snaps from missing rows; neither enters the trend as zero", () => {
    const noSnaps = dataWeek(2, [row(2, "5850", "KC", { gms_active: 1 }), rows(2)[1]]);
    const missing = dataWeek(3, rows(3).filter(r => r.player_id !== "5850"));
    const history = playerUsageWeeks([dataWeek(1), noSnaps, missing, dataWeek(4)], "5850");
    expect(history.map(w => w.status)).toEqual(["played", "no_offensive_snaps_reported", "missing_data", "played"]);
    expect(history[1]!.metrics.rec_tgt).toBeNull();
    expect(usageTrend(history)).toMatchObject({ played_weeks: 2, baseline_weeks: [1], recent_weeks: [4] });
  });
  it("does not use dressed-only rows to claim a complete team feed", () => {
    const w = dataWeek(1, [row(1, "5850", "KC", { gms_active: 1 })]);
    expect(teamTotals(w, "KC")).toMatchObject({ usable: false, targets: null });
    expect(playerUsageWeeks([w], "5850")[0]!.status).toBe("missing_data");
  });
  it("treats volume without snap counts as partial data", () => {
    const w = dataWeek(1, [row(1, "5850", "KC", { rec_tgt: 4 }), rows(1)[1]]);
    expect(teamTotals(w, "KC").usable).toBe(false);
    expect(playerUsageWeeks([w], "5850")[0]!.metrics.target_share).toBeNull();
    expect(playerUsageWeeks([w], "5850")[0]!.metrics.rec_tgt).toBe(4);
  });
  it("keeps known player counts and snap share when a teammate makes team-volume shares uncertain", () => {
    const w = dataWeek(1, [
      row(1, "5850", "KC", { off_snp: 30, tm_off_snp: 60, rec_tgt: 5 }),
      row(1, "4046", "KC", { rec_tgt: 1, gp: 1 }),
    ]);
    const history = playerUsageWeeks([w], "5850");
    expect(history[0]).toMatchObject({
      status: "played", metrics: { off_snp: 30, rec_tgt: 5, snap_share: 50, target_share: null },
      denominators: { usable: false, targets: null },
    });
    expect(usageTrend(history).metrics.rec_tgt).toMatchObject({ recent: { mean: 5, samples: 1 } });
    expect(usageTrend(history).metrics.target_share).toMatchObject({ recent: { mean: null, samples: 0 } });
  });
  it("nulls missing/inconsistent snap denominators without inventing zero shares", () => {
    const a = dataWeek(1, [row(1, "5850", "KC", { off_snp: 30, rec_tgt: 2 })]);
    const b = dataWeek(2, [row(2, "5850", "KC", { off_snp: 30, tm_off_snp: 20, rec_tgt: 2 })]);
    const history = playerUsageWeeks([a, b], "5850");
    expect(history.map(w => w.metrics.snap_share)).toEqual([null, null]);
    expect(usageTrend(history).metrics.snap_share).toMatchObject({ delta: null, recent: { samples: 0 } });
  });
  it("retains negative air yards and does not cap legitimate air-yard shares", () => {
    const w = dataWeek(1, [
      row(1, "5850", "KC", { off_snp: 30, tm_off_snp: 60, rec_air_yd: -10 }),
      row(1, "4046", "KC", { off_snp: 30, tm_off_snp: 60, rec_air_yd: 20 }),
    ]);
    expect(playerUsageWeeks([w], "5850")[0]!.metrics.air_yard_share).toBe(-100);
    expect(playerUsageWeeks([w], "4046")[0]!.metrics.air_yard_share).toBe(200);
  });
  it("uses the weekly team after a trade and excludes other-team weeks from team trends", () => {
    const first = dataWeek(1, [
      row(1, "5850", "ATL", { off_snp: 30, tm_off_snp: 60, rec_tgt: 2 }),
      row(1, "9226", "ATL", { off_snp: 30, tm_off_snp: 60, rec_tgt: 8 }),
    ]);
    const history = playerUsageWeeks([first, dataWeek(2)], "5850");
    expect(history.map(w => w.team)).toEqual(["ATL", "KC"]);
    expect(history.map(w => w.metrics.target_share)).toEqual([20, 40]);
    expect(usageTrend(history).teams).toEqual(["ATL", "KC"]);
    const teamHistory = playerUsageWeeks([first, dataWeek(2)], "5850", "KC");
    expect(teamHistory[0]!.status).toBe("other_team");
    expect(usageTrend(teamHistory).played_weeks).toBe(1);
  });
  it("labels only bracketed same-team byes as inferred, never uses the current team", () => {
    const bye: UsageWeek = { week: 2, rows: [], games: games(2).filter(g => g.home !== "KC"), status: "available", reason: null };
    expect(playerUsageWeeks([dataWeek(1), bye, dataWeek(3)], "5850")[1]).toMatchObject({
      status: "inferred_bye", team: "KC", team_basis: "surrounding_stat_rows",
    });
    expect(playerUsageWeeks([dataWeek(1), bye], "5850")[1]!.status).toBe("missing_data");
    const traded = dataWeek(3, [row(3, "5850", "ATL")]);
    expect(playerUsageWeeks([dataWeek(1), bye, traded], "5850")[1]!.status).toBe("missing_data");
  });
});

describe("usage windows", () => {
  it("defaults to four prior completed calendar weeks, never the live current week", () => {
    expect(usageWindow(state, schedule, "2026", 4)).toEqual([1, 2, 3, 4]);
    expect(() => usageWindow(state, schedule, "2026", 4, 5)).toThrow(/past/);
  });
  it("keeps unfinished earlier weeks visible but does not default the endpoint to one", () => {
    const partial = schedule.map(g => g.week === 4 ? { ...g, status: "in_game" } : g);
    expect(usageWindow(state, partial, "2026", 4)).toEqual([1, 2, 3]);
    expect(usageWindow(state, partial, "2026", 4, 4)).toEqual([1, 2, 3, 4]);
  });
  it("handles preseason, week 1, postseason and historical season lengths", () => {
    expect(usageWindow({ ...state, season_type: "pre" }, [], "2026", 4)).toEqual([]);
    expect(usageWindow({ ...state, week: 1 }, [], "2026", 4)).toEqual([]);
    const lastGame = [{ ...schedule[0]!, week: 18 }];
    expect(usageWindow({ ...state, season_type: "post" }, lastGame, "2026", 2)).toEqual([17, 18]);
    expect(() => usageWindow(state, schedule, "2020", 2, 18)).toThrow();
    expect(() => usageWindow(state, [], "2025", 4)).toThrow(/schedule/);
    expect(() => usageWindow(state, schedule, "2027", 4)).toThrow(/year/);
  });
});

describe("usage MCP tools", () => {
  it("resolves names, deduplicates player IDs, shares one request per week and reuses cache across both tools", async () => {
    const c = await connectedClient(routes(), { allowWrites: false });
    try {
      const r = await c.call("get_player_trends", { player_ids: ["5850", "4046", "5850"] });
      expect(r.result.isError).toBeFalsy();
      const d = r.data as any;
      expect(d.read_only).toBe(true);
      expect(d.players).toHaveLength(2);
      expect(d.players[0].player).toMatchObject({ name: "Travis Kelce", current_team: "KC" });
      expect(d.players[0].trend.played_weeks).toBe(4);
      expect(d.coverage).toHaveLength(4);
      expect(d.coverage[0].upstream_updated_at_range.newest).toBe("2026-10-01T00:00:00.000Z");
      const team = await c.call("get_team_usage", { team: "kc" });
      expect(team.result.isError).toBeFalsy();
      expect(team.data).toMatchObject({ team: "KC", team_name: "Kansas City Chiefs" });
      expect(c.ff.calls.filter(p => p.startsWith("https://api.sleeper.com/stats/"))).toHaveLength(4);
      expect(c.ff.calls.some(p => p.includes("graphql"))).toBe(false);
      expect(c.ff.calls.filter(p => p.includes("/projections/"))).toHaveLength(0);
    } finally { await c.close(); }
  });
  it("preserves good weeks when one endpoint fails, another is malformed and another is empty", async () => {
    const c = await connectedClient({
      ...routes(), [statUrl(1)]: () => ({ status: 503 }), [statUrl(2)]: {}, [statUrl(3)]: [],
    });
    try {
      const r = await c.call("get_player_trends", { player_ids: ["5850"] });
      expect(r.result.isError).toBeFalsy();
      expect((r.data as any).coverage.map((w: any) => w.status)).toEqual(["missing_data", "missing_data", "missing_data", "available"]);
      expect((r.data as any).players[0].trend.played_weeks).toBe(1);
      expect((r.data as any).players[0].weeks[0].metrics.rec_tgt).toBeNull();
    } finally { await c.close(); }
  });
  it("does not fetch unfinished games and reports a schedule-confirmed team bye", async () => {
    const sch = schedule.filter(g => !(g.week === 2 && g.home === "KC"))
      .map(g => g.week === 3 ? { ...g, status: "in_game" } : g);
    const c = await connectedClient({
      ...routes(), "https://api.sleeper.app/schedule/nfl/regular/2026": sch,
      [statUrl(2)]: [row(2, "9226", "ATL")],
    });
    try {
      const r = await c.call("get_team_usage", { team: "KC" });
      expect((r.data as any).team_weeks.map((w: any) => w.status)).toEqual(["available", "bye", "not_completed", "available"]);
      expect(c.ff.calls).not.toContain(statUrl(3));
      expect((r.data as any).players.find((p: any) => p.player.id === "5850").weeks[1].status).toBe("inferred_bye");
    } finally { await c.close(); }
  });
  it("accepts Washington alias and gives a readable empty preseason result", async () => {
    const c = await connectedClient({ ...routes(), "/state/nfl": { ...state, season_type: "pre", week: 0 } });
    try {
      const r = await c.call("get_team_usage", { team: "wsh" });
      expect(r.data).toMatchObject({ team: "WAS", coverage: [], players: [] });
      expect(r.data!.warning).toMatch(/No completed/);
      expect(c.ff.calls.some(p => p.startsWith("https://api.sleeper.com/stats/"))).toBe(false);
    } finally { await c.close(); }
  });
  it("reports an absent team's feed as missing rather than zero volume", async () => {
    const c = await connectedClient(routes());
    try {
      const r = await c.call("get_team_usage", { team: "BUF", weeks: 1 });
      expect((r.data as any).team_weeks[0]).toMatchObject({ status: "missing_data", usable: false, targets: null, row_count: 0 });
    } finally { await c.close(); }
  });
  it("resolves row names when the player database does not know a historical player", async () => {
    const c = await connectedClient({ ...routes(), [statUrl(4)]: [row(4, "999888")] });
    try {
      const r = await c.call("get_team_usage", { team: "KC", weeks: 1 });
      expect((r.data as any).players[0].player).toMatchObject({ id: "999888", name: "Example 999888", pos: "TE" });
    } finally { await c.close(); }
  });
  it("warns explicitly when no weekly stats can be used", async () => {
    const c = await connectedClient({ ...routes(), [statUrl(4)]: null });
    try {
      const r = await c.call("get_player_trends", { player_ids: ["5850"], weeks: 1 });
      expect(r.data!.warning).toMatch(/No usable weekly stats/);
      expect((r.data as any).players[0].trend.played_weeks).toBe(0);
    } finally { await c.close(); }
  });
  it.each([
    ["get_player_trends", { player_ids: ["bad"] }],
    ["get_player_trends", { player_ids: ["DET"] }],
    ["get_player_trends", { player_ids: ["4195"] }],
    ["get_player_trends", { player_ids: [] }],
    ["get_player_trends", { player_ids: ["5850"], weeks: 9 }],
    ["get_player_trends", { player_ids: ["5850"], end_week: 5 }],
    ["get_player_trends", { player_ids: ["5850"], season: "2027" }],
    ["get_player_trends", { player_ids: ["5850"], season: "../bad" }],
    ["get_team_usage", { team: "XYZ" }],
  ])("rejects invalid/unsupported input without fetching usage (%#)", async (name, args) => {
    const c = await connectedClient(routes());
    try {
      const r = await c.call(name as string, args as Record<string, unknown>);
      expect(r.result.isError).toBe(true);
      expect(c.ff.calls.some(p => p.startsWith("https://api.sleeper.com/stats/"))).toBe(false);
    } finally { await c.close(); }
  });
});
