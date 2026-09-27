import { describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.js";
import { boxScoreProgress, loadWeekGames } from "../src/games.js";
import type { NflState, ScheduleGame, StatMap } from "../src/sleeper/types.js";

const TEAM: Record<string, string> = { qb_atl: "ATL", rb_atl: "ATL", qb_nyj: "NYJ", rb_nyj: "NYJ", qb_kc: "KC", qb_buf: "BUF" };
const teamOf = (id: string) => TEAM[id] ?? null;

describe("boxScoreProgress", () => {
  it("measures a live game by the plays run so far: rushes, pass attempts and sacks", () => {
    const done = boxScoreProgress(
      {
        qb_atl: { pass_att: 18, pass_sack: 2, rush_att: 1 },
        rb_atl: { rush_att: 10, rec: 3, rec_yd: 25 },
        qb_nyj: { pass_att: 12 },
        unknown_player: { rush_att: 30 },
      },
      teamOf,
    );
    expect(done.get("ATL")).toBeCloseTo(31 / 62, 9); // half of a typical game's plays
    expect(done.get("NYJ")).toBeCloseTo(12 / 62, 9);
    expect(done.size).toBe(2);
  });

  it("never ends a game from plays alone, and lets final snap counts take over", () => {
    const done = boxScoreProgress({ qb_kc: { pass_att: 50, rush_att: 30 }, qb_buf: { pass_att: 40, rush_att: 25, tm_off_snp: 70 } }, teamOf);
    expect(done.get("KC")).toBe(0.97);
    expect(done.get("BUF")).toBe(1);
  });
});

describe("loadWeekGames", () => {
  const state = { season: "2026", season_type: "regular", week: 5 } as NflState;
  const schedule: ScheduleGame[] = [
    { game_id: "1", week: 5, date: "2026-10-11", home: "ATL", away: "NYJ", status: "in_game" },
    { game_id: "2", week: 5, date: "2026-10-11", home: "KC", away: "BUF", status: "in_game" },
    { game_id: "3", week: 5, date: "2026-10-08", home: "DET", away: "SF", status: "complete" },
    { game_id: "4", week: 5, date: "2026-10-12", home: "CIN", away: "MIN", status: "pre_game" },
  ];
  const fakeContext = (stats: StatMap | Error) =>
    ({
      client: {
        getSchedule: async () => schedule,
        getStats: async () => {
          if (stats instanceof Error) throw stats;
          return stats;
        },
      },
      players: { raw: (id: string) => (TEAM[id] ? { team: TEAM[id] } : undefined) },
      log: () => {},
    }) as unknown as ServerContext;

  it("averages both teams' plays, since they run off the same clock", async () => {
    // ATL has run 40 plays and NYJ 22: 62 together, so each side has half a game left.
    const games = await loadWeekGames(
      fakeContext({ qb_atl: { pass_att: 25, rush_att: 3 }, rb_atl: { rush_att: 12 }, qb_nyj: { pass_att: 14, pass_sack: 1 }, rb_nyj: { rush_att: 7 } }),
      "2026",
      5,
      state,
    );
    expect(games.source).toBe("schedule");
    for (const team of ["ATL", "NYJ"]) {
      expect(games.game(team).state).toBe("playing");
      expect(games.game(team).remaining).toBeCloseTo(0.5, 9);
    }
    // KC and BUF have kicked off but have no plays in the box scores yet: the whole game is left.
    expect(games.game("KC")).toEqual({ state: "playing", remaining: 1 });
    expect(games.game("DET")).toEqual({ state: "final", remaining: 0 });
    expect(games.game("CIN")).toEqual({ state: "yet_to_play", remaining: 1 });
    expect(games.game("IND").state).toBe("bye");
  });

  it("counts a live game as halfway when the box scores cannot be loaded", async () => {
    const games = await loadWeekGames(fakeContext(new Error("503 Service Unavailable")), "2026", 5, state);
    expect(games.game("ATL")).toEqual({ state: "playing", remaining: 0.5 });
    expect(games.game("DET")).toEqual({ state: "final", remaining: 0 });
  });
});
