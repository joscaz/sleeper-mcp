import { afterEach, describe, expect, it } from "vitest";
import { connectedClient } from "./helpers.js";
import { LEAGUE_ID, SCHEDULE_URL, matchupsWeek5, players, preKickoffSchedule2026, projectionsWeek5, rosters } from "./fixtures.js";
import type { InjuryFeed, InjuryItem } from "../src/injuries/espn.js";

// All league, roster, points and reports below are synthetic fixtures. No account client is configured.
let connection: Awaited<ReturnType<typeof connectedClient>> | undefined;
afterEach(async () => { await connection?.close(); connection = undefined; });
const args = { league_id: LEAGUE_ID, roster_id: 1 };
const positive = { ...projectionsWeek5, "5850": { rec: 10, rec_yd: 150 } }; // 25 under fixture league scoring, despite Out.
type Entry = { id: string; pts: number; proj_left: number; projected_final: number; status?: string; scored?: number };
const entry = (data: Record<string, unknown>, field: string) => (data[field] as Entry[]).find((p) => p.id === "5850");

function feed(items: InjuryItem[]): InjuryFeed {
  return { get: async () => ({
    snapshot: { items, retrievedAt: Date.now(), expiresAt: Date.now() + 300_000, feedUpdatedAt: null }, error: null,
  }) };
}

const returnReport: InjuryItem = {
  athleteId: null, name: "Travis Kelce", team: "KC", position: "TE", designation: null,
  reportedAt: "2026-10-01T12:00:00Z", note: "Synthetic older report expecting return.",
  bodyPart: null, url: null,
};

async function setup(status: string | null = "Out", injuryFeed?: InjuryFeed, overrides: Record<string, unknown> = {}) {
  connection = await connectedClient({
    "/players/nfl": { ...players, "5850": { ...players["5850"], injury_status: status } },
    [SCHEDULE_URL]: preKickoffSchedule2026,
    [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5.map((m) => ({ ...m, points: 0, players_points: {} })),
    "/projections/nfl/regular/2026/5": positive,
    ...overrides,
  }, { injuryFeed });
  return connection;
}

async function forecasts() {
  const lineup = await connection!.call("get_lineup_projections", args);
  const odds = await connection!.call("get_matchup_odds", args);
  const comparison = await connection!.call("compare_lineups", {
    ...args, scenarios: [{ name: "Keep current starters", starters: rosters[0]!.starters }],
  });
  for (const result of [lineup, odds, comparison]) expect(result.result.isError, result.text).toBeFalsy();
  const sides = ((odds.data!.matchups as { teams: Record<string, unknown>[] }[])[0]!).teams;
  return { lineup: lineup.data!, odds: odds.data!, side: sides[0]!, comparison: comparison.data! };
}

describe("shared weekly availability scoring", () => {
  it.each(["Out", "IR", "PUP", "Sus", "NFI-R", "NA", "DNR", "COV"])(
    "zeros a positive %s projection consistently and does not optimize an unavailable player", async (status) => {
      await setup(status);
      const { lineup, side, comparison, odds } = await forecasts();
      expect(entry(lineup, "current_lineup")?.pts).toBe(0);
      expect(entry(side, "starters")?.proj_left).toBe(0);
      expect(entry(comparison.baseline as Record<string, unknown>, "starters")?.projected_final).toBe(0);
      expect((lineup.optimal_lineup as Entry[]).find((p) => (p as Entry & { slot: string }).slot === "TE")?.id).toBe("9509");
      expect(entry(lineup, "optimal_lineup")).toBeUndefined();
      expect(lineup.current_projected_total).toBe((comparison.baseline as Record<string, unknown>).projected_total);
      expect(Number(side.projected)).toBeCloseTo(Number(lineup.current_projected_total), 0);
      expect(lineup.availability_policy).toBe(comparison.availability_policy);
      expect(lineup.availability_policy).toBe(odds.availability_policy);
    },
  );

  it.each(["Questionable", "Doubtful", null])("keeps %s distinct from ruled out", async (status) => {
    await setup(status);
    const { lineup, side, comparison } = await forecasts();
    expect(entry(lineup, "current_lineup")?.pts).toBe(25);
    expect(entry(side, "starters")?.proj_left).toBe(25);
    expect(entry(comparison.baseline as Record<string, unknown>, "starters")?.projected_final).toBe(25);
    expect(entry(lineup, "optimal_lineup")?.pts).toBe(25);
    if (status) expect(lineup.needs_check).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: expect.objectContaining({ id: "5850" }) }),
    ]));
  });

  it("excludes ruled-out bench candidates even when no eligible replacement exists", async () => {
    await setup("Out", undefined, {
      [`/league/${LEAGUE_ID}/rosters`]: rosters.map((r) => r.roster_id === 1
        ? { ...r, players: r.players!.filter((id) => id !== "9509"), starters: r.starters!.map((id) => id === "5850" ? "0" : id) } : r),
      [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5.map((m) => m.roster_id === 1
        ? { ...m, starters: m.starters!.map((id) => id === "5850" ? "0" : id) } : m),
    });
    const { data, result } = await connection!.call("get_lineup_projections", args);
    expect(result.isError).toBeFalsy();
    expect((data!.optimal_lineup as { slot: string; id: string }[]).find((p) => p.slot === "TE")?.id).toBe("0");
    expect(entry(data!, "bench")?.pts).toBe(0);
    expect((data!.suggested_changes as { start: Entry[] } | null)?.start.some((p) => p.id === "5850") ?? false).toBe(false);
  });

  it.each(["bye", "no_game"])("does not optimize a ruled-out player with %s game status", async (status) => {
    await setup("Out", undefined, {
      [SCHEDULE_URL]: status === "bye" ? preKickoffSchedule2026.filter((g) => ![g.home, g.away].includes("KC"))
        : preKickoffSchedule2026.map((g) => [g.home, g.away].includes("KC") ? { ...g, status: "canceled" } : g),
    });
    const { lineup, side } = await forecasts();
    expect(entry(lineup, "current_lineup")).toMatchObject({ pts: 0, status });
    expect(entry(side, "starters")?.proj_left).toBe(0);
    expect(entry(lineup, "optimal_lineup")).toBeUndefined();
  });

  it("keeps the raw projection feed distinct from the availability-adjusted forecast", async () => {
    await setup();
    const raw = await connection!.call("get_projections", { ...args, player_ids: ["5850"], scoring: "league" });
    expect(raw.result.isError).toBeFalsy();
    expect(entry(raw.data!, "players")?.pts).toBe(25);
    const adjusted = await connection!.call("get_lineup_projections", args);
    expect(entry(adjusted.data!, "current_lineup")?.pts).toBe(0);
  });

  it.each(["conflicting return report", "not listed", "source unavailable"])(
    "does not let optional news change Sleeper scoring: %s", async (mode) => {
      const optional = mode === "source unavailable" ? { get: async () => { throw new Error("synthetic outage"); } }
        : feed(mode === "not listed" ? [] : [returnReport]);
      await setup("Out", optional);
      const { lineup, side, comparison, odds } = await forecasts();
      expect(entry(lineup, "current_lineup")?.pts).toBe(0);
      expect(entry(side, "starters")?.proj_left).toBe(0);
      expect(entry(comparison.baseline as Record<string, unknown>, "starters")?.projected_final).toBe(0);
      expect(entry(lineup, "optimal_lineup")).toBeUndefined();
      if (mode === "conflicting return report") {
        for (const result of [lineup, odds]) {
          expect(result.needs_check).toEqual(expect.arrayContaining([
            expect.objectContaining({ player: expect.objectContaining({ id: "5850" }),
              injury_context: expect.objectContaining({ conflict: true, reports: [
                expect.objectContaining({ source: "sleeper", designation: "Out" }),
                expect.objectContaining({ source: "espn", designation: null, reported_at: returnReport.reportedAt }),
              ] }) }),
          ]));
        }
        expect(comparison.injury_context).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "5850", injury_context: expect.objectContaining({ conflict: true }) }),
        ]));
      }
    },
  );

  it("does not zero a Sleeper projection from an ESPN-only Out report", async () => {
    await setup(null, feed([{ ...returnReport, designation: "Out" }]));
    const { lineup, side } = await forecasts();
    expect(entry(lineup, "current_lineup")?.pts).toBe(25);
    expect(entry(side, "starters")?.proj_left).toBe(25);
    expect(lineup.needs_check).toEqual(expect.arrayContaining([
      expect.objectContaining({ player: expect.objectContaining({ id: "5850" }) }),
    ]));
  });

  it("uses the same adjusted total in lineup checks without converting conflicts into write suggestions", async () => {
    await setup("Out", feed([returnReport]));
    const { data: lineup } = await connection!.call("get_lineup_projections", args);
    const check = await connection!.call("check_lineups", { username: "alice", league_ids: [LEAGUE_ID] });
    expect(check.result.isError).toBeFalsy();
    const report = (check.data!.leagues as Record<string, unknown>[])[0]!;
    expect(report.projected_total).toBe(lineup!.current_projected_total);
    expect(report.set_lineup).toBeUndefined();
    expect(report.needs_check).toEqual(expect.arrayContaining([
      expect.objectContaining({ injury_context: expect.objectContaining({ conflict: true }) }),
    ]));
  });

  it.each(["in_game", "complete"])("preserves scored points and locks after kickoff (%s)", async (status) => {
    await setup("Out", undefined, {
      [SCHEDULE_URL]: preKickoffSchedule2026.map((g) => [g.home, g.away].includes("KC") ? { ...g, status } : g),
      [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5.map((m) => ({ ...m, points: 7, players_points: { "5850": 7 } })),
    });
    const { lineup, side, comparison } = await forecasts();
    const player = entry(lineup, "current_lineup")!;
    const left = entry(side, "starters")!.proj_left;
    expect(player.scored).toBe(7);
    expect(player.status).toBe(status === "complete" ? "final" : "playing");
    expect(player.pts).toBeGreaterThanOrEqual(7);
    expect(player.pts).toBeCloseTo(7 + left, 0);
    if (status === "in_game") expect(left).toBeGreaterThan(0);
    else expect(left).toBe(0);
    expect(entry(lineup, "optimal_lineup")?.id).toBe("5850");
    expect(entry(comparison.baseline as Record<string, unknown>, "starters")?.projected_final).toBe(player.pts);
  });

  it("does not project today's Out flag onto a future week", async () => {
    await setup("Out", undefined, {
      [SCHEDULE_URL]: preKickoffSchedule2026.map((g) => ({ ...g, week: 6 })),
      [`/league/${LEAGUE_ID}/matchups/6`]: matchupsWeek5,
      "/projections/nfl/regular/2026/6": positive,
    });
    const lineup = await connection!.call("get_lineup_projections", { ...args, week: 6 });
    const odds = await connection!.call("get_matchup_odds", { ...args, week: 6 });
    expect(lineup.result.isError).toBeFalsy();
    expect(odds.result.isError).toBeFalsy();
    expect(entry(lineup.data!, "current_lineup")?.pts).toBe(25);
    const side = (odds.data!.matchups as { teams: Record<string, unknown>[] }[])[0]!.teams[0]!;
    expect(entry(side, "starters")?.proj_left).toBe(25);
    expect(lineup.data!.needs_check).toBeUndefined();
    expect(odds.data!.needs_check).toBeUndefined();
  });
});
