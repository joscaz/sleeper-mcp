import { describe, expect, it } from "vitest";
import {
  firstRoundByes,
  hashSeed,
  mulberry32,
  normalCdf,
  normalSampler,
  simulateSeason,
  teamOutlook,
  winProbability,
  type SimTeam,
  type SimWeek,
} from "../src/odds.js";

describe("win probability", () => {
  it("normalCdf matches known quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 4);
    expect(normalCdf(3)).toBeCloseTo(0.99865, 4);
  });

  it("is symmetric, and exact once nothing is left to play", () => {
    const a = { mean: 120, variance: 400 };
    const b = { mean: 110, variance: 500 };
    expect(winProbability(a, b) + winProbability(b, a)).toBeCloseTo(1, 9);
    expect(winProbability(a, b)).toBeCloseTo(normalCdf(10 / 30), 9);
    expect(winProbability(a, a)).toBeCloseTo(0.5, 6); // the CDF approximation is good to ~1.5e-7
    expect(winProbability({ mean: 101, variance: 0 }, { mean: 100, variance: 0 })).toBe(1);
    expect(winProbability({ mean: 100, variance: 0 }, { mean: 101, variance: 0 })).toBe(0);
    expect(winProbability({ mean: 100, variance: 0 }, { mean: 100, variance: 0 })).toBe(0.5);
  });

  it("teamOutlook adds points so far to each starter's projection for the time left", () => {
    const t = teamOutlook([
      { points: 24, projection: 20, remaining: 0, pos: "QB" }, // final
      { points: 6, projection: 16, remaining: 0.5, pos: "WR" }, // halfway through
      { points: 0, projection: 10, remaining: 1, pos: "TE" }, // not started
      { points: 0, projection: 12, remaining: 0, pos: "RB" }, // bye or no game
    ]);
    expect(t.points).toBe(30);
    expect(t.still_to_come).toBeCloseTo(18, 9);
    expect(t.mean).toBeCloseTo(48, 9);
    // Variance shrinks with the share of the game left: WR (0.6 × 16)² × 0.5 + TE (0.65 × 10)² × 1.
    expect(t.variance).toBeCloseTo(0.6 ** 2 * 256 * 0.5 + 0.65 ** 2 * 100, 9);
  });

  it("firstRoundByes follows bracket sizes", () => {
    expect([2, 3, 4, 5, 6, 7, 8, 10, 12].map(firstRoundByes)).toEqual([0, 1, 0, 3, 2, 1, 0, 6, 4]);
  });
});

describe("seeded randomness", () => {
  it("is reproducible and close to a standard normal", () => {
    const a = mulberry32(hashSeed("league:3"));
    const b = mulberry32(hashSeed("league:3"));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hashSeed("a")).not.toBe(hashSeed("b"));

    const normal = normalSampler(mulberry32(42));
    const xs = Array.from({ length: 20_000 }, normal);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeGreaterThan(0.97);
    expect(sd).toBeLessThan(1.03);
  });
});

describe("simulateSeason", () => {
  const team = (roster_id: number, wins = 0, losses = 0, points_for = 0): SimTeam => ({ roster_id, wins, losses, ties: 0, points_for });
  const rotation: [number, number][][] = [
    [
      [1, 2],
      [3, 4],
    ],
    [
      [1, 3],
      [2, 4],
    ],
    [
      [1, 4],
      [2, 3],
    ],
  ];
  const week = (w: number, means: number[], pairs: [number, number][] | null = rotation[w % 3]!, sd = 20): SimWeek => ({
    week: w,
    pairs,
    scores: new Map(means.map((m, i) => [i + 1, { mean: m, variance: sd * sd }])),
    projected: true,
  });

  it("hands out exactly the available playoff spots, byes and #1 seed", () => {
    const teams = [team(1), team(2), team(3), team(4)];
    const weeks = Array.from({ length: 6 }, (_, i) => week(i + 1, [110, 105, 100, 95]));
    const r = simulateSeason(teams, weeks, { simulations: 4000, seed: 7, playoffTeams: 3, byes: 1 });
    const total = (key: "playoffs" | "bye" | "top_seed") => r.teams.reduce((s, t) => s + t[key], 0);
    expect(total("playoffs")).toBeCloseTo(3, 9);
    expect(total("bye")).toBeCloseTo(1, 9);
    expect(total("top_seed")).toBeCloseTo(1, 9);
    for (const t of r.teams) expect(t.avg_wins + t.avg_losses + t.avg_ties).toBeCloseTo(6, 9);
    expect(r.teams[0]!.playoffs).toBeGreaterThan(r.teams[3]!.playoffs);
  });

  it("gives the same answer for the same seed", () => {
    const teams = [team(1), team(2), team(3), team(4)];
    const weeks = Array.from({ length: 4 }, (_, i) => week(i + 1, [100, 100, 100, 100]));
    const run = () => simulateSeason(teams, weeks, { simulations: 2000, seed: 123, playoffTeams: 2, byes: 0 });
    expect(run()).toEqual(run());
  });

  it("locks in a team that cannot be caught and rules out one that cannot catch up", () => {
    const teams = [team(1, 10, 0), team(2, 5, 5), team(3, 5, 5), team(4, 0, 10)];
    const weeks = [week(11, [100, 100, 100, 100]), week(12, [100, 100, 100, 100])];
    const r = simulateSeason(teams, weeks, { simulations: 2000, seed: 1, playoffTeams: 2, byes: 0 });
    expect(r.teams[0]).toMatchObject({ playoffs: 1, top_seed: 1 });
    expect(r.teams[3]!.playoffs).toBe(0);
  });

  it("breaks record ties on points for", () => {
    const teams = [team(1, 5, 5, 1000), team(2, 5, 5, 1400), team(3, 0, 10), team(4, 0, 10)];
    const r = simulateSeason(teams, [], { simulations: 10, seed: 1, playoffTeams: 1, byes: 0 });
    expect(r.teams[1]!.playoffs).toBe(1);
    expect(r.teams[0]!.playoffs).toBe(0);
  });

  it("adds a game against the league median each week when the league plays one", () => {
    const teams = [team(1), team(2), team(3), team(4)];
    const weeks = Array.from({ length: 3 }, (_, i) => week(i + 1, [120, 110, 100, 90]));
    const r = simulateSeason(teams, weeks, { simulations: 1000, seed: 5, playoffTeams: 2, byes: 0, medianGame: true });
    for (const t of r.teams) expect(t.avg_wins + t.avg_losses + t.avg_ties).toBeCloseTo(6, 9);
    // Per week: 2 head-to-head wins plus 2 wins against the median.
    expect(r.teams.reduce((s, t) => s + t.avg_wins + t.avg_ties / 2, 0)).toBeCloseTo(12, 9);
  });

  it("draws opponents at random when the schedule is unknown, one game per team", () => {
    const teams = [team(1), team(2), team(3), team(4)];
    const r = simulateSeason(teams, [week(1, [100, 100, 100, 100], null)], { simulations: 500, seed: 9, playoffTeams: 2, byes: 0 });
    for (const t of r.teams) expect(t.avg_wins + t.avg_losses + t.avg_ties).toBeCloseTo(1, 9);
  });

  it("with shared random draws, a stronger team only gains odds and the rest of the league gives them up", () => {
    const teams = [team(1), team(2), team(3), team(4)];
    const options = { simulations: 3000, seed: 99, playoffTeams: 2, byes: 0 };
    const before = simulateSeason(teams, Array.from({ length: 6 }, (_, i) => week(i + 1, [100, 100, 100, 100])), options);
    const after = simulateSeason(teams, Array.from({ length: 6 }, (_, i) => week(i + 1, [108, 100, 100, 100])), options);
    const gain = after.teams[0]!.playoffs - before.teams[0]!.playoffs;
    expect(gain).toBeGreaterThan(0);
    const othersChange = [1, 2, 3].reduce((sum, i) => sum + after.teams[i]!.playoffs - before.teams[i]!.playoffs, 0);
    expect(othersChange).toBeCloseTo(-gain, 9);
  });

  it("breaks a team's odds down by this week's result and by final win total", () => {
    const teams = [team(1, 3, 3), team(2, 3, 3), team(3, 3, 3), team(4, 3, 3)];
    const weeks = Array.from({ length: 4 }, (_, i) => week(i + 6, [100, 100, 100, 100]));
    const r = simulateSeason(teams, weeks, { simulations: 4000, seed: 11, playoffTeams: 2, byes: 0, focusRosterId: 1 });
    const f = r.focus!;
    expect(f.first_week).toMatchObject({ week: 6, opponent: 2 });
    expect(f.first_week!.win).toBeGreaterThan(0.4);
    expect(f.first_week!.win).toBeLessThan(0.6);
    expect(f.first_week!.playoffs_if_win!).toBeGreaterThan(f.first_week!.playoffs_if_loss!);
    expect(f.by_final_wins.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 9);
    const byWins = new Map(f.by_final_wins.map((e) => [e.wins, e.playoffs]));
    expect(byWins.get(7)).toBe(1);
    expect(byWins.get(3)).toBe(0);
  });
});
