import { afterEach, describe, expect, it } from "vitest";
import { SleeperGraphqlClient } from "../src/sleeper/graphql.js";
import { connectedClient } from "./helpers.js";
import { LEAGUE_ID, SCHEDULE_URL, league, matchupsWeek5, preKickoffSchedule2026, rosters, state } from "./fixtures.js";

type Vars = Record<string, unknown>;
type Handler = (variables: Vars) => unknown;
const starters = [...rosters[0]!.starters!];
const withLaporta = starters.map((id) => id === "5850" ? "9509" : id);
let connected: Awaited<ReturnType<typeof connectedClient>> | undefined;

afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

async function setup(options: { weekly?: string[]; routes?: Record<string, unknown> } = {}) {
  let weekly = [...(options.weekly ?? starters)];
  const calls: { op: string; vars: Vars }[] = [];
  const leg = () => ({ league_id: LEAGUE_ID, roster_id: 1, matchup_id: 1, round: 5, leg: 5, starters: [...weekly] });
  const handlers: Record<string, Handler> = {
    me: () => ({ user_id: "111", username: "alice" }),
    league_rosters: () => structuredClone(rosters),
    matchup_legs: () => [leg()],
    // Deliberately model roster defaults separately from the scoring lineup.
    roster_update_starters: (v) => ({ ...rosters[0], starters: v.starters }),
    update_matchup_leg: (v) => {
      weekly = [...(v.starters as string[])];
      return leg();
    },
  };
  const auth = new SleeperGraphqlClient({
    token: "test-only",
    fetch: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const op = request.operationName as string;
      calls.push({ op, vars: request.variables });
      const result = handlers[op]?.(request.variables);
      return new Response(JSON.stringify({ data: { [op]: result ?? null } }), { status: 200 });
    }) as typeof fetch,
  });
  connected = await connectedClient({
    [SCHEDULE_URL]: preKickoffSchedule2026,
    [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5.map((m) => m.roster_id === 1 ? { ...m, starters: weekly } : m),
    ...options.routes,
  }, { auth, defaultUser: "alice" });
  return { ...connected, calls, handlers, getWeekly: () => weekly };
}

describe("weekly lineup authority", () => {
  it("uses weekly starters rather than roster defaults in projections", async () => {
    const { call } = await setup({ weekly: withLaporta });
    const { data } = await call("get_lineup_projections", { league_id: LEAGUE_ID, username: "alice" });
    expect((data!.current_lineup as { slot: string; id: string }[]).find((p) => p.slot === "TE")?.id).toBe("9509");
  });

  it("shows the weekly lineup in roster reads and does not repair an already-benched player", async () => {
    const { call } = await setup({ weekly: withLaporta });
    const roster = await call("get_roster", { league_id: LEAGUE_ID, username: "alice" });
    expect((roster.data!.starters as { slot: string; id: string }[]).find((p) => p.slot === "TE")?.id).toBe("9509");
    const check = await call("check_lineups", { username: "alice" });
    const reports = check.data!.leagues as { problems?: { slot: string }[] }[];
    expect(reports[0]!.problems?.some((p) => p.slot === "TE") ?? false).toBe(false);
  });

  it("writes the current weekly matchup and verifies it independently", async () => {
    const { call, calls, getWeekly } = await setup();
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBeFalsy();
    expect(getWeekly()).toEqual(withLaporta);
    expect(calls.find((c) => c.op === "update_matchup_leg")?.vars).toEqual({
      league_id: LEAGUE_ID, roster_id: 1, round: 5, leg: 5, starters: withLaporta,
    });
    expect(calls.some((c) => c.op === "roster_update_starters")).toBe(false);
    expect(calls.at(-1)?.op).toBe("matchup_legs");
    expect(data).toMatchObject({ week: 5, verified: true });
  });

  it("does not treat a mutation echo as proof that the scoring lineup changed", async () => {
    const { call, handlers } = await setup();
    handlers.update_matchup_leg = (v) => ({ roster_id: 1, round: 5, leg: 5, starters: v.starters });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/not verified/i);
  });

  it("refuses to write when the current weekly lineup is missing", async () => {
    const { call, handlers, calls } = await setup();
    handlers.matchup_legs = () => [];
    const { result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.op.startsWith("update_") || c.op.startsWith("roster_update"))).toBe(false);
  });

  it("uses public matchup starters without a Sleeper session", async () => {
    connected = await connectedClient({
      [SCHEDULE_URL]: preKickoffSchedule2026,
      [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5.map((m) => m.roster_id === 1 ? { ...m, starters: withLaporta } : m),
    });
    const roster = await connected.call("get_roster", { league_id: LEAGUE_ID, username: "alice" });
    expect((roster.data!.starters as { slot: string; id: string }[]).find((p) => p.slot === "TE")?.id).toBe("9509");
  });

  it("does not silently substitute roster defaults when public weekly data is missing", async () => {
    connected = await connectedClient({ [`/league/${LEAGUE_ID}/matchups/5`]: [] });
    const { result, text } = await connected.call("get_lineup_projections", { league_id: LEAGUE_ID, username: "alice" });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/Roster defaults are not a verified weekly lineup/);
  });

  it("previews the weekly lineup without sending any mutation", async () => {
    const { call, calls, getWeekly } = await setup();
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }], dry_run: true });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ dry_run: true, week: 5, lineup_source: "weekly_matchup" });
    expect(data).not.toHaveProperty("verified");
    expect(getWeekly()).toEqual(starters);
    expect(calls.some((c) => /^(update_|roster_update)/.test(c.op))).toBe(false);
  });

  it("recognizes a no-op from the weekly lineup rather than roster defaults", async () => {
    const { call, calls } = await setup({ weekly: withLaporta });
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Sam LaPorta" }] });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ changed: false, week: 5 });
    expect(calls.some((c) => /^(update_|roster_update)/.test(c.op))).toBe(false);
  });

  it.each([
    { label: "null response", value: null },
    { label: "wrong week", value: [{ league_id: LEAGUE_ID, roster_id: 1, round: 5, leg: 4, starters }] },
    { label: "wrong league", value: [{ league_id: "other", roster_id: 1, round: 5, leg: 5, starters }] },
    { label: "null starters", value: [{ league_id: LEAGUE_ID, roster_id: 1, round: 5, leg: 5, starters: null }] },
    { label: "wrong slot count", value: [{ league_id: LEAGUE_ID, roster_id: 1, round: 5, leg: 5, starters: ["4046"] }] },
    { label: "no scoring matchup", value: [{ league_id: LEAGUE_ID, roster_id: 1, round: 5, leg: 5, matchup_id: null, starters }] },
  ])("rejects $label before sending a write", async ({ value }) => {
    const { call, calls, handlers } = await setup();
    handlers.matchup_legs = () => value;
    const { result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(calls.some((c) => /^(update_|roster_update)/.test(c.op))).toBe(false);
  });

  it("reports failed verification distinctly after a mutation has been sent", async () => {
    const { call, handlers, calls, ctx } = await setup();
    await ctx.client.getMatchups(LEAGUE_ID, 5);
    let reads = 0;
    const read = handlers.matchup_legs!;
    handlers.matchup_legs = (v) => ++reads < 3 ? read(v) : null;
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/not verified.*request was sent.*read-back failed/i);
    expect(calls.filter((c) => c.op === "update_matchup_leg")).toHaveLength(1);
    const before = connected!.ff.calls.filter((p) => p.endsWith("/matchups/5")).length;
    await ctx.client.getMatchups(LEAGUE_ID, 5);
    expect(connected!.ff.calls.filter((p) => p.endsWith("/matchups/5"))).toHaveLength(before + 1);
  });

  it("stops if another change is observed during preflight", async () => {
    const { call, handlers, calls } = await setup();
    let reads = 0;
    handlers.matchup_legs = () => [{
      league_id: LEAGUE_ID, roster_id: 1, matchup_id: 1, round: 5, leg: 5,
      starters: ++reads === 1 ? starters : withLaporta,
    }];
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/changed while.*nothing was sent/i);
    expect(calls.some((c) => c.op === "update_matchup_leg")).toBe(false);
  });

  it("rechecks the week immediately before writing", async () => {
    const { call, calls } = await setup({
      routes: { "/state/nfl": (n: number) => ({ status: 200, body: { ...state, week: n === 1 ? 5 : 6, leg: n === 1 ? 5 : 6 } }) },
    });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/week.*nothing was sent/i);
    expect(calls.some((c) => c.op === "update_matchup_leg")).toBe(false);
  });

  it("does not infer playoff leg identity from roster defaults", async () => {
    const { call, calls, handlers } = await setup({
      routes: {
        "/state/nfl": { ...state, week: 15, leg: 15 },
        [`/league/${LEAGUE_ID}`]: { ...league, settings: { ...league.settings, leg: 15, playoff_week_start: 15, playoff_round_type: 2 } },
        [SCHEDULE_URL]: preKickoffSchedule2026.map((g) => ({ ...g, week: 15 })),
      },
    });
    let weekly = [...starters];
    handlers.matchup_legs = () => [{ league_id: LEAGUE_ID, roster_id: 1, matchup_id: 1, round: 15, leg: 15, starters: weekly }];
    handlers.update_matchup_leg = (v) => { weekly = v.starters as string[]; return null; };
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ week: 15, verified: true });
    expect(calls.find((c) => c.op === "update_matchup_leg")?.vars).toMatchObject({ round: 15, leg: 15 });
  });

  it.each(["KC", "DET"])("rejects moving a locked starter or bench player (%s)", async (team) => {
    const { call, calls } = await setup({
      routes: { [SCHEDULE_URL]: preKickoffSchedule2026.map((g) => [g.home, g.away].includes(team) ? { ...g, status: "complete" } : g) },
    });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/locked.*game has started/i);
    expect(calls.some((c) => c.op === "update_matchup_leg")).toBe(false);
  });

  it("preserves locked players while changing other slots", async () => {
    const { call, calls } = await setup({
      routes: { [SCHEDULE_URL]: preKickoffSchedule2026.map((g) => [g.home, g.away].includes("KC") ? { ...g, status: "complete" } : g) },
    });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Jonathan Taylor", bench: "Breece Hall" }] });
    expect(result.isError, text).toBeFalsy();
    expect(calls.find((c) => c.op === "update_matchup_leg")?.vars.starters).toEqual(starters.map((id) => id === "8138" ? "6813" : id));
  });

  it("refuses writes when the schedule is unavailable", async () => {
    const { call, calls } = await setup({ routes: { [SCHEDULE_URL]: () => ({ status: 503 }) } });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/Cannot verify kickoff locks/);
    expect(calls.some((c) => c.op === "update_matchup_leg")).toBe(false);
  });

  it("refreshes kickoff locks again just before sending", async () => {
    const { call, calls } = await setup({
      routes: {
        [SCHEDULE_URL]: (n: number) => ({
          status: 200,
          body: preKickoffSchedule2026.map((g) => n > 1 && [g.home, g.away].includes("KC") ? { ...g, status: "in_game" } : g),
        }),
      },
    });
    const { result, text } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/locked/);
    expect(calls.some((c) => c.op === "update_matchup_leg")).toBe(false);
  });

  it("keeps roster-default updates for pre-season leagues", async () => {
    const { call, calls } = await setup({ routes: { [`/league/${LEAGUE_ID}`]: { ...league, status: "pre_draft" } } });
    const { data, result } = await call("set_lineup", { league_id: LEAGUE_ID, moves: [{ start: "Sam LaPorta", bench: "Travis Kelce" }] });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ lineup_source: "roster_defaults" });
    expect(data).not.toHaveProperty("verified");
    expect(calls.some((c) => c.op === "roster_update_starters")).toBe(true);
    expect(calls.some((c) => c.op === "update_matchup_leg")).toBe(false);
  });

  it("does not proceed with an IR move when benching the weekly starter is unverified", async () => {
    const { call, handlers, calls } = await setup();
    handlers.update_matchup_leg = (v) => ({ ...v });
    handlers.roster_update_reserve = (v) => ({ ...rosters[0], reserve: v.reserve });
    const { result, text } = await call("update_ir", { league_id: LEAGUE_ID, add: ["Travis Kelce"] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/not verified/i);
    expect(calls.some((c) => c.op === "roster_update_reserve")).toBe(false);
  });

  it("reports a partial IR failure after verified benching", async () => {
    const { call, handlers } = await setup();
    handlers.roster_update_reserve = () => { throw new Error("IR rejected"); };
    const { result, text } = await call("update_ir", { league_id: LEAGUE_ID, add: ["Travis Kelce"] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/Weekly starters were updated and verified, but the IR move failed/);
  });
});
