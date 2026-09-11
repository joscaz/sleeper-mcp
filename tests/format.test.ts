import { describe, expect, it } from "vitest";
import { buildTeamIndex, keyStats, leagueType, points, record, rosterShape, scoreStatLine, scoringSummary, startingSlots, teamLabel, waiverType } from "../src/format.js";
import { league, leagueUsers, rosters } from "./fixtures.js";

describe("format helpers", () => {
  it("summarizes scoring", () => {
    const s = scoringSummary(league);
    expect(s.format).toBe("PPR");
    expect(s.te_premium).toBe(0.5);
    expect(s.pass_td).toBe(4);
    expect(s.pass_yd_per_point).toBe(25);
    expect(s.superflex).toBe(false);
    expect(s.bonuses).toEqual({ bonus_rec_te: 0.5 });
    expect(scoringSummary({ scoring_settings: { rec: 0.5 }, roster_positions: ["QB", "SUPER_FLEX"], settings: {} }).format).toBe("Half PPR");
    expect(scoringSummary({ scoring_settings: { rec: 0.5 }, roster_positions: ["QB", "SUPER_FLEX"], settings: {} }).superflex).toBe(true);
    expect(scoringSummary({ scoring_settings: {}, roster_positions: [], settings: {} }).format).toBe("Standard");
  });

  it("describes roster shapes and starting slots", () => {
    expect(rosterShape(league.roster_positions)).toBe("QB, RB×2, WR×2, TE, FLEX, K, DEF, BN×3, IR, TAXI×2");
    expect(startingSlots(league)).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);
    expect(leagueType(league)).toBe("dynasty");
    expect(waiverType(league)).toBe("faab");
  });

  it("computes records and points with decimals", () => {
    const s = rosters[0]!.settings;
    expect(record(s)).toBe("3-1");
    expect(record({ wins: 1, losses: 1, ties: 1 })).toBe("1-1-1");
    expect(points(s, "fpts")).toBe(520.5);
    expect(points(s, "fpts_against")).toBe(480.1);
  });

  it("maps rosters to team names and managers", () => {
    const index = buildTeamIndex(rosters, leagueUsers);
    expect(index.get(1)).toEqual({ roster_id: 1, team_name: "Alice's Avengers", manager: "Alice", user_id: "111" });
    expect(index.get(2)?.team_name).toBe("Team Bobby Tables");
    expect(teamLabel(index, 1)).toBe("Alice's Avengers (Alice)");
    expect(teamLabel(index, 2)).toBe("Team Bobby Tables (Bobby Tables)");
    expect(teamLabel(index, 42)).toBe("Roster 42");
    expect(teamLabel(index, null)).toBeNull();
  });

  it("scores stat lines against league settings", () => {
    const pts = scoreStatLine({ pass_yd: 300, pass_td: 2, pass_int: 1, rec: 3, rec_yd: 20 }, league.scoring_settings);
    // 300*0.04 + 2*4 - 1 + 3*1 + 20*0.1 = 12 + 8 - 1 + 3 + 2 = 24
    expect(pts).toBe(24);
    expect(scoreStatLine(null, league.scoring_settings)).toBe(0);
  });

  it("picks position-relevant stat columns", () => {
    expect(keyStats({ pass_yd: 300, pass_td: 2, rec: 0, rush_yd: 12 }, "QB")).toEqual({ pass_yd: 300, pass_td: 2, rush_yd: 12 });
    expect(keyStats({ rec: 7, rec_yd: 91.3, pass_yd: 0 }, "WR")).toEqual({ rec: 7, rec_yd: 91.3 });
    expect(keyStats(null, "RB")).toEqual({});
  });
});
