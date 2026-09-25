import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectedClient } from "./helpers.js";
import {
  DRAFT_ID,
  LEAGUE_ID,
  PREV_LEAGUE_ID,
  SCHEDULE_URL,
  league,
  liveMatchupsWeek5,
  liveStatsWeek5,
  matchupsWeek5,
  projectionsWeek5,
} from "./fixtures.js";

type Connected = Awaited<ReturnType<typeof connectedClient>>;
let c: Connected;

beforeEach(async () => {
  c = await connectedClient();
});
afterEach(async () => {
  await c.close();
});

describe("server surface", () => {
  it("exposes every tool with read-only annotations, plus prompts and resources", async () => {
    const { tools } = await c.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_draft",
        "get_draft_picks",
        "get_drafts",
        "get_free_agents",
        "get_league",
        "get_league_history",
        "get_league_rosters",
        "get_league_standings",
        "get_lineup_projections",
        "get_matchup_odds",
        "get_matchups",
        "get_nfl_state",
        "get_player",
        "get_player_stats",
        "get_playoff_bracket",
        "get_playoff_odds",
        "get_projections",
        "get_roster",
        "get_traded_picks",
        "get_transactions",
        "get_trending_players",
        "get_user",
        "get_user_leagues",
        "search_players",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
    }
    const { prompts } = await c.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["trade_analysis", "waiver_wire_report", "weekly_briefing"]);
    const { resources } = await c.client.listResources();
    expect(resources.map((r) => r.uri)).toContain("sleeper://nfl/state");
    const { resourceTemplates } = await c.client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain("sleeper://league/{league_id}");
  });

  it("serves resources", async () => {
    const textOf = (contents: Record<string, unknown>[]) => (typeof contents[0]?.text === "string" ? contents[0].text : "{}");
    const state = await c.client.readResource({ uri: "sleeper://nfl/state" });
    expect(JSON.parse(textOf(state.contents))).toMatchObject({ week: 5, season: "2026" });
    const league = await c.client.readResource({ uri: `sleeper://league/${LEAGUE_ID}` });
    expect(JSON.parse(textOf(league.contents))).toMatchObject({ name: "Test Dynasty", type: "dynasty" });
  });

  it("renders prompts with arguments", async () => {
    const prompt = await c.client.getPrompt({ name: "weekly_briefing", arguments: { league_id: LEAGUE_ID, username: "alice", week: "5" } });
    const text = prompt.messages[0]!.content.type === "text" ? prompt.messages[0]!.content.text : "";
    expect(text).toContain(`league ${LEAGUE_ID}`);
    expect(text).toContain("week 5");
  });
});

describe("users & leagues", () => {
  it("get_nfl_state", async () => {
    const { data } = await c.call("get_nfl_state");
    expect(data).toMatchObject({ week: 5, season_type: "regular" });
  });

  it("get_user resolves username and id", async () => {
    expect((await c.call("get_user", { username: "alice" })).data).toMatchObject({ user_id: "111", avatar_url: "https://sleepercdn.com/avatars/abc123" });
    expect((await c.call("get_user", { user_id: "222" })).data).toMatchObject({ username: "bob" });
    const missing = await c.call("get_user", { username: "nobody" });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);
  });

  it("get_user_leagues defaults season to the current league season", async () => {
    const { data } = await c.call("get_user_leagues", { username: "alice" });
    expect(data).toMatchObject({ user_id: "111", season: "2026", count: 1 });
    const leagues = data!.leagues as Record<string, unknown>[];
    expect(leagues[0]).toMatchObject({ league_id: LEAGUE_ID, scoring: "PPR, TE premium +0.5", type: "dynasty", teams: 4 });
    const prev = await c.call("get_user_leagues", { username: "alice", season: 2025 });
    expect((prev.data!.leagues as unknown[])).toHaveLength(1);
  });

  it("get_league summarizes settings", async () => {
    const { data } = await c.call("get_league", { league_id: LEAGUE_ID });
    expect(data).toMatchObject({
      name: "Test Dynasty",
      type: "dynasty",
      waivers: { type: "faab", faab_budget: 100 },
      playoffs: { teams: 2, week_start: 15 },
      trade_deadline_week: 12,
      divisions: { "1": "East", "2": "West" },
      commissioners: ["Alice"],
      taxi_slots: 2,
    });
    expect(data!.raw_scoring_settings).toBeUndefined();
    const raw = await c.call("get_league", { league_id: LEAGUE_ID, include_raw: true });
    expect(raw.data!.raw_scoring_settings).toMatchObject({ rec: 1 });
  });

  it("get_league reports unknown leagues cleanly", async () => {
    const { result, text } = await c.call("get_league", { league_id: "404404404" });
    expect(result.isError).toBe(true);
    expect(text).toContain("404404404");
    expect(text).toContain("get_user_leagues");
  });

  it("get_league_standings sorts by wins then points and resolves names", async () => {
    const { data } = await c.call("get_league_standings", { league_id: LEAGUE_ID });
    const rows = data!.standings as Record<string, unknown>[];
    expect(rows.map((r) => r.roster_id)).toEqual([2, 1, 3, 4]);
    expect(rows[1]).toMatchObject({ rank: 2, team_name: "Alice's Avengers", manager: "Alice", record: "3-1", points_for: 520.5, faab_remaining: 65, division: "East", streak: "2W" });
    expect(rows[0]).toMatchObject({ team_name: "Team Bobby Tables", faab_remaining: 100 });
    expect(data).toMatchObject({ faab_budget: 100, playoff_teams: 2 });
  });

  it("get_league_history walks previous seasons and finds champions", async () => {
    const { data } = await c.call("get_league_history", { league_id: LEAGUE_ID, max_seasons: 5 });
    expect(data!.seasons_found).toBe(2);
    const seasons = data!.seasons as Record<string, unknown>[];
    expect(seasons[0]).toMatchObject({ season: "2026", league_id: LEAGUE_ID, champion: null });
    expect(seasons[1]).toMatchObject({ season: "2025", league_id: PREV_LEAGUE_ID, champion: "Alice's Avengers (Alice)", runner_up: "Team Bobby Tables (Bobby Tables)" });
  });
});

describe("rosters & matchups", () => {
  it("get_roster by username labels starters with slots and separates bench", async () => {
    const { data } = await c.call("get_roster", { league_id: LEAGUE_ID, username: "alice" });
    expect(data).toMatchObject({ roster_id: 1, team_name: "Alice's Avengers", record: "3-1", faab_remaining: 65 });
    const starters = data!.starters as Record<string, unknown>[];
    expect(starters.map((s) => s.slot)).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);
    expect(starters[0]).toMatchObject({ id: "4046", name: "Patrick Mahomes", pos: "QB", team: "KC" });
    expect(starters[5]).toMatchObject({ name: "Travis Kelce", inj: "Out" });
    expect(starters[8]).toMatchObject({ id: "DET", name: "Detroit Lions", pos: "DEF" });
    const bench = data!.bench as Record<string, unknown>[];
    expect(bench.map((b) => b.name)).toEqual(["Jonathan Taylor", "Sam LaPorta"]);
  });

  it("get_roster accepts roster_id, user_id, display name and team_name", async () => {
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, roster_id: 2 })).data).toMatchObject({ team_name: "Team Bobby Tables" });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, user_id: "333" })).data).toMatchObject({ team_name: "Carol Cartel" });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, username: "Bobby Tables" })).data).toMatchObject({ roster_id: 2 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team_name: "cartel" })).data).toMatchObject({ roster_id: 3 });
    // `team` takes whatever name the caller has: username, display name or (partial) team name.
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "bob" })).data).toMatchObject({ roster_id: 2 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "Bobby Tables" })).data).toMatchObject({ roster_id: 2 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "cartel" })).data).toMatchObject({ roster_id: 3 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "nobody" })).result.isError).toBe(true);
    const bad = await c.call("get_roster", { league_id: LEAGUE_ID, team_name: "zzz" });
    expect(bad.result.isError).toBe(true);
    expect(bad.text).toContain("Alice's Avengers");
    const none = await c.call("get_roster", { league_id: LEAGUE_ID });
    expect(none.result.isError).toBe(true);
    // Empty starter slots are shown as (empty) rather than dropped.
    const bob = await c.call("get_roster", { league_id: LEAGUE_ID, roster_id: 2 });
    const slots = bob.data!.starters as Record<string, unknown>[];
    expect(slots).toHaveLength(9);
    expect(slots[1]).toMatchObject({ id: "0", name: "(empty)", slot: "RB" });
  });

  it("get_league_rosters lists everyone, optionally without bench", async () => {
    const { data } = await c.call("get_league_rosters", { league_id: LEAGUE_ID, include_bench: false });
    const rs = data!.rosters as Record<string, unknown>[];
    expect(rs).toHaveLength(4);
    expect(rs[0]!.bench).toBeUndefined();
    expect(rs.map((r) => r.team_name)).toEqual(["Alice's Avengers", "Team Bobby Tables", "Carol Cartel", "Dave Nation"]);
  });

  it("get_matchups pairs teams, defaults the week and reports per-player points", async () => {
    const { data } = await c.call("get_matchups", { league_id: LEAGUE_ID });
    expect(data!.week).toBe(5);
    const matchups = data!.matchups as Record<string, unknown>[];
    expect(matchups).toHaveLength(2);
    const first = matchups[0]!;
    expect(first).toMatchObject({ matchup_id: 1, leader: "Alice's Avengers", margin: 27.2 });
    const teams = first.teams as Record<string, unknown>[];
    expect(teams[0]).toMatchObject({ team_name: "Alice's Avengers", points: 128.4 });
    const starters = teams[0]!.starters as Record<string, unknown>[];
    expect(starters[0]).toMatchObject({ name: "Patrick Mahomes", slot: "QB", pts: 24.1 });
    expect(teams[0]!.bench).toBeUndefined();
  });

  it("get_matchups can focus on one team and include bench points", async () => {
    const { data } = await c.call("get_matchups", { league_id: LEAGUE_ID, week: 5, username: "alice", include_bench: true });
    const matchups = data!.matchups as Record<string, unknown>[];
    expect(matchups).toHaveLength(1);
    const teams = matchups[0]!.teams as Record<string, unknown>[];
    const bench = teams[0]!.bench as Record<string, unknown>[];
    expect(bench).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Jonathan Taylor", pts: 15.5 })]));
  });

  it("get_matchups explains empty weeks", async () => {
    const { result, text } = await c.call("get_matchups", { league_id: LEAGUE_ID, week: 6 });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/No matchups for week 6/);
  });

  it("get_playoff_bracket labels rounds and resolves teams", async () => {
    const { data } = await c.call("get_playoff_bracket", { league_id: PREV_LEAGUE_ID, bracket: "both" });
    const winners = data!.winners_bracket as { matches: Record<string, unknown>[] };
    expect(winners.matches[0]).toMatchObject({ label: "Championship", team1: "Alice's Avengers (Alice)", winner: "Alice's Avengers (Alice)" });
    expect(data!.losers_bracket).toEqual({ rounds: 0, matches: [] });
  });
});

describe("transactions & picks", () => {
  it("get_transactions resolves players, teams, picks and FAAB, hiding failed claims by default", async () => {
    const { data } = await c.call("get_transactions", { league_id: LEAGUE_ID });
    expect(data).toMatchObject({ weeks: 5, total: 2 });
    const [trade, waiver] = data!.transactions as Record<string, unknown>[];
    expect(trade).toMatchObject({ type: "trade", teams: ["Alice's Avengers (Alice)", "Team Bobby Tables (Bobby Tables)"] });
    expect(trade!.trade_summary).toEqual({
      "Alice's Avengers (Alice)": { gave: ["Drake London (WR, ATL)", "$15 FAAB"], got: ["Jonathan Taylor (RB, IND)", "2027 round 2"] },
      "Team Bobby Tables (Bobby Tables)": { gave: ["Jonathan Taylor (RB, IND)", "2027 round 2"], got: ["Drake London (WR, ATL)", "$15 FAAB"] },
    });
    expect(waiver).toMatchObject({ type: "waiver", faab_bid: 22 });
    expect((waiver!.adds as Record<string, unknown>[])[0]).toMatchObject({ player: "Rookie Runner (RB, GB)", to: "Carol Cartel (Carol)" });

    const failed = await c.call("get_transactions", { league_id: LEAGUE_ID, status: "failed" });
    expect(failed.data!.total).toBe(1);
    expect((failed.data!.transactions as Record<string, unknown>[])[0]).toMatchObject({ status: "failed", notes: "Outbid" });

    const trades = await c.call("get_transactions", { league_id: LEAGUE_ID, all_weeks: true, type: "trade" });
    expect(trades.data).toMatchObject({ weeks: "1-5", total: 1 });
  });

  it("get_traded_picks groups by current owner", async () => {
    const { data } = await c.call("get_traded_picks", { league_id: LEAGUE_ID });
    const byOwner = data!.by_current_owner as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(byOwner).sort()).toEqual(["Alice's Avengers (Alice)", "Dave Nation (Dave)"]);
    expect(byOwner["Alice's Avengers (Alice)"]![0]).toMatchObject({ pick: "2027 round 2", original_owner: "Team Bobby Tables (Bobby Tables)" });
  });
});

describe("drafts", () => {
  it("get_drafts by league and by user", async () => {
    expect((await c.call("get_drafts", { league_id: LEAGUE_ID })).data).toMatchObject({ count: 1 });
    const byUser = await c.call("get_drafts", { username: "alice" });
    expect(byUser.data).toMatchObject({ user_id: "111", season: "2026", count: 1 });
    expect((byUser.data!.drafts as Record<string, unknown>[])[0]).toMatchObject({ draft_id: DRAFT_ID, type: "snake", rounds: 3 });
    expect((await c.call("get_drafts", {})).result.isError).toBe(true);
  });

  it("get_draft resolves the draft order", async () => {
    const { data } = await c.call("get_draft", { league_id: LEAGUE_ID });
    expect(data).toMatchObject({ draft_id: DRAFT_ID, pick_timer_seconds: 90 });
    const order = data!.draft_order as Record<string, unknown>[];
    expect(order.map((o) => o.manager)).toEqual(["Alice", "Bobby Tables", "Carol", "Dave"]);
    expect(order[0]).toMatchObject({ slot: 1, roster_id: 1 });
  });

  it("get_draft_picks resolves players and supports filters", async () => {
    const all = await c.call("get_draft_picks", { draft_id: DRAFT_ID });
    expect(all.data!.total_picks).toBe(5);
    const picks = all.data!.picks as Record<string, unknown>[];
    expect(picks[0]).toMatchObject({ pick_no: 1, round: 1, pick_in_round: 1, player: "Bijan Robinson", pos: "RB", picked_by: "Alice" });
    expect(picks[3]).toMatchObject({ player: "Josh Allen", keeper: true });
    expect(picks[4]).toMatchObject({ pick_no: 5, round: 2, pick_in_round: 1 });

    const round2 = await c.call("get_draft_picks", { league_id: LEAGUE_ID, round: 2 });
    expect(round2.data!.returned).toBe(1);

    const dave = await c.call("get_draft_picks", { draft_id: DRAFT_ID, username: "dave" });
    expect((dave.data!.picks as Record<string, unknown>[]).map((p) => p.player)).toEqual(["Josh Allen", "Patrick Mahomes"]);
  });
});

describe("players", () => {
  it("search_players", async () => {
    const { data } = await c.call("search_players", { query: "mahomes" });
    expect(data!.count).toBe(1);
    expect((data!.players as Record<string, unknown>[])[0]).toMatchObject({ player_id: "4046", name: "Patrick Mahomes", pos: "QB", team: "KC", age: 31, exp: 9, rank: 20 });
    const qbs = await c.call("search_players", { position: "qb", limit: 2 });
    expect((qbs.data!.players as Record<string, unknown>[]).map((p) => p.name)).toEqual(["Josh Allen", "Patrick Mahomes"]);
    expect((await c.call("search_players", {})).result.isError).toBe(true);
  });

  it("get_player by id, by team code and by name", async () => {
    const byId = await c.call("get_player", { player_id: "6813" });
    expect(byId.data).toMatchObject({ name: "Jonathan Taylor", injury: { status: "Questionable", body_part: "Ankle" }, headshot_url: "https://sleepercdn.com/content/nfl/players/thumb/6813.jpg" });
    const def = await c.call("get_player", { player_id: "det" });
    expect(def.data).toMatchObject({ name: "Detroit Lions", pos: "DEF" });
    const byName = await c.call("get_player", { name: "justin jefferson" });
    expect(byName.data).toMatchObject({ player_id: "6794" });
    expect((await c.call("get_player", { name: "nobody at all" })).result.isError).toBe(true);
  });

  it("get_trending_players resolves names", async () => {
    const { data } = await c.call("get_trending_players", {});
    expect((data!.players as Record<string, unknown>[])[0]).toMatchObject({ rank: 1, name: "Rookie Runner", adds: 12345 });
    const drops = await c.call("get_trending_players", { type: "drop" });
    expect((drops.data!.players as Record<string, unknown>[])[0]).toMatchObject({ name: "Travis Kelce", drops: 5000 });
  });

  it("get_free_agents excludes rostered players and annotates trending", async () => {
    const { data } = await c.call("get_free_agents", { league_id: LEAGUE_ID });
    const fas = data!.free_agents as Record<string, unknown>[];
    const names = fas.map((f) => f.name);
    expect(names).not.toContain("Patrick Mahomes");
    expect(names).not.toContain("Retired Ron");
    expect(names).toEqual(["Injured Ian", "Rookie Runner", "Handcuff Harry", "Streamer Steve"]);
    expect(fas[1]).toMatchObject({ trending_adds_24h: 12345 });
    const rbs = await c.call("get_free_agents", { league_id: LEAGUE_ID, position: "RB", include_injured: false });
    expect((rbs.data!.free_agents as Record<string, unknown>[]).map((f) => f.name)).toEqual(["Rookie Runner", "Handcuff Harry"]);
  });
});

describe("projections & stats", () => {
  it("get_projections for a team under league scoring", async () => {
    const { data } = await c.call("get_projections", { league_id: LEAGUE_ID, username: "alice", scoring: "league" });
    expect(data).toMatchObject({ kind: "projections", week: 5, season: "2026", team_filter: true });
    const players = data!.players as Record<string, unknown>[];
    expect(players[0]).toMatchObject({ name: "Patrick Mahomes" });
    // 290*0.04 + 2.1*4 - 0.6 + 15*0.1 = 11.6 + 8.4 - 0.6 + 1.5 = 20.9
    expect(players[0]!.pts).toBe(20.9);
    expect(players.some((p) => p.name === "Josh Allen")).toBe(false);
  });

  it("get_projections by position and season-long", async () => {
    const { data } = await c.call("get_projections", { position: "QB", scoring: "half_ppr", limit: 1 });
    expect((data!.players as Record<string, unknown>[])[0]).toMatchObject({ name: "Josh Allen", pts: 23.9 });
    const season = await c.call("get_projections", { week: 0, player_ids: ["9226"] });
    expect(season.data).toMatchObject({ week: "season", total: 1 });
    expect((await c.call("get_projections", { scoring: "league" })).result.isError).toBe(true);
  });

  it("get_player_stats returns actuals and explains missing weeks", async () => {
    const { data } = await c.call("get_player_stats", { week: 4, player_ids: ["4046", "9226"] });
    const players = data!.players as Record<string, unknown>[];
    expect(players.map((p) => p.name)).toEqual(["Patrick Mahomes", "Bijan Robinson"]);
    expect(players[0]).toMatchObject({ pts: 24.1, stats: { pass_yd: 310, pass_td: 3, pass_int: 1 } });
    const empty = await c.call("get_player_stats", { week: 5 });
    expect(empty.result.isError).toBe(true);
    expect(empty.text).toMatch(/No stats available/);
  });

  it("get_lineup_projections finds the optimal lineup and flags problems", async () => {
    const { data } = await c.call("get_lineup_projections", { league_id: LEAGUE_ID, username: "alice" });
    expect(data).toMatchObject({ week: 5, team_name: "Alice's Avengers" });
    const current = data!.current_lineup as Record<string, unknown>[];
    expect(current.map((p) => p.slot)).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);
    const optimal = data!.optimal_lineup as Record<string, unknown>[];
    // Kelce (Out, 0 pts) should be replaced by LaPorta at TE, and Taylor should move into the lineup over Hall/London.
    expect(optimal.find((p) => p.slot === "TE")).toMatchObject({ name: "Sam LaPorta" });
    const optimalNames = optimal.map((p) => p.name);
    expect(optimalNames).toContain("Jonathan Taylor");
    expect(optimalNames).not.toContain("Travis Kelce");
    expect(data!.projected_gain as number).toBeGreaterThan(0);
    const changes = data!.suggested_changes as { start: Record<string, unknown>[]; sit: Record<string, unknown>[] };
    expect(changes.sit.map((p) => p.name)).toContain("Travis Kelce");
    expect(changes.start.map((p) => p.name)).toEqual(expect.arrayContaining(["Sam LaPorta", "Jonathan Taylor"]));
    expect(data!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Travis Kelce .*Out/)]));
  });

  it("get_lineup_projections warns about empty slots", async () => {
    const { data } = await c.call("get_lineup_projections", { league_id: LEAGUE_ID, roster_id: 2 });
    expect((data!.warnings as string[]).filter((w) => w.startsWith("Empty")).length).toBe(7);
  });
});

describe("odds", () => {
  const live = { [`/league/${LEAGUE_ID}/matchups/5`]: liveMatchupsWeek5, "/stats/nfl/regular/2026/5": liveStatsWeek5 };
  type Starter = { id: string; name: string; status: string; pts: number; proj_left: number };
  type Side = { roster_id: number; team_name: string; points: number; projected: number; win_pct: number; starters_left: number; starters?: Starter[] };
  type OddsMatchup = { matchup_id: number; status: string; teams: Side[]; favorite?: string | null; winner?: string };

  it("get_matchup_odds combines live points with projections for the time each starter has left", async () => {
    const o = await connectedClient(live);
    try {
      const all = await o.call("get_matchup_odds", { league_id: LEAGUE_ID });
      expect(all.data!.game_status_source).toBe("schedule");
      const [m1, m2] = all.data!.matchups as OddsMatchup[];
      expect(m1!.status).toBe("in_progress");
      expect(m1!.favorite).toBe("Alice's Avengers");
      expect(m1!.teams[0]!.starters).toBeUndefined();
      expect(m1!.teams[0]!.win_pct + m1!.teams[1]!.win_pct).toBeCloseTo(100, 5);
      expect(m1!.teams[0]!.win_pct).toBeGreaterThan(99);
      expect(m2!.status).toBe("no_lineups");
      expect(m2!.teams.map((t) => t.win_pct)).toEqual([50, 50]);

      const mine = await o.call("get_matchup_odds", { league_id: LEAGUE_ID, username: "alice" });
      const side = (mine.data!.matchups as OddsMatchup[])[0]!.teams[0]!;
      expect(side).toMatchObject({ team_name: "Alice's Avengers", points: 54.1, starters_left: 6 });
      expect(side.projected).toBeCloseTo(108.45, 0);
      const byName = new Map(side.starters!.map((s) => [s.name, s]));
      expect(byName.get("Patrick Mahomes")).toMatchObject({ status: "final", pts: 24.1, proj_left: 0 });
      // Projected 20.8 under league scoring; ATL has run 48 of ~64 snaps, so a quarter of that is left.
      expect(byName.get("Bijan Robinson")).toMatchObject({ status: "playing", pts: 10, proj_left: 5.2 });
      // No NYJ box score yet: a live game with unknown progress counts as halfway.
      expect(byName.get("Breece Hall")).toMatchObject({ status: "playing", proj_left: 6.7 });
      expect(byName.get("Ja'Marr Chase")).toMatchObject({ status: "yet_to_play", pts: 0, proj_left: 19.7 });
      expect(byName.get("Travis Kelce")).toMatchObject({ status: "final", pts: 0, proj_left: 0 });

      const theirs = await o.call("get_matchup_odds", { league_id: LEAGUE_ID, team: "bob" });
      expect((theirs.data!.matchups as OddsMatchup[])[0]!.teams[0]!.roster_id).toBe(2);
    } finally {
      await o.close();
    }
  });

  it("get_matchup_odds reports past weeks as results without fetching projections", async () => {
    const o = await connectedClient({ [`/league/${LEAGUE_ID}/matchups/4`]: matchupsWeek5 });
    try {
      const past = await o.call("get_matchup_odds", { league_id: LEAGUE_ID, week: 4 });
      expect(past.data!.game_status_source).toBe("past_week");
      const [m1, m2] = past.data!.matchups as OddsMatchup[];
      expect(m1).toMatchObject({ status: "final", winner: "Alice's Avengers" });
      expect(m1!.teams.map((t) => t.win_pct)).toEqual([100, 0]);
      expect(m2!.winner).toBe("Dave Nation");
      expect(o.ff.calls.some((path) => path.startsWith("/projections/"))).toBe(false);
    } finally {
      await o.close();
    }
  });

  it("get_matchup_odds falls back to box scores when the schedule is unavailable", async () => {
    const o = await connectedClient({ ...live, [SCHEDULE_URL]: () => ({ status: 500 }) });
    try {
      const res = await o.call("get_matchup_odds", { league_id: LEAGUE_ID, username: "alice" });
      expect(res.data!.game_status_source).toBe("box_scores");
      const starters = (res.data!.matchups as OddsMatchup[])[0]!.teams[0]!.starters!;
      expect(starters.find((s) => s.name === "Bijan Robinson")).toMatchObject({ status: "playing", proj_left: 5.2 });
      expect(starters.find((s) => s.name === "Ja'Marr Chase")?.status).toBe("yet_to_play");
    } finally {
      await o.close();
    }
  });

  it("get_playoff_odds simulates the rest of the regular season over the real schedule", async () => {
    // Weeks 6-14: a rotating schedule, except week 13 (no pairings yet) and week 14 (no projections yet).
    const future: Record<string, unknown> = {};
    const rotation = [
      [1, 3, 2, 4],
      [1, 4, 2, 3],
      [1, 2, 3, 4],
    ];
    for (let week = 6; week <= 14; week++) {
      const order = rotation[week % 3]!;
      future[`/league/${LEAGUE_ID}/matchups/${week}`] = order.map((roster_id, i) => ({
        roster_id,
        matchup_id: week === 13 ? null : i < 2 ? 1 : 2,
        points: 0,
        custom_points: null,
        starters: [],
        players: [],
        players_points: {},
      }));
      if (week !== 14) future[`/projections/nfl/regular/2026/${week}`] = projectionsWeek5;
    }
    const o = await connectedClient({ ...live, ...future });
    try {
      const res = await o.call("get_playoff_odds", { league_id: LEAGUE_ID, username: "alice" });
      const d = res.data!;
      expect(d).toMatchObject({ weeks_simulated: "5-14", simulations: 10000, playoff_teams: 2 });
      expect(d.first_round_byes).toBeUndefined();
      const teams = d.teams as { roster_id: number; playoff_pct: number; top_seed_pct: number }[];
      expect(teams.slice(0, 2).map((t) => t.roster_id).sort()).toEqual([1, 2]);
      expect(teams.reduce((sum, t) => sum + t.playoff_pct, 0)).toBeCloseTo(200, 0);
      expect(teams.find((t) => t.roster_id === 1)).toMatchObject({ playoff_pct: 100, top_seed_pct: 100 });
      expect(teams.find((t) => t.roster_id === 4)!.playoff_pct).toBe(0);

      const focus = d.focus as { team_name: string; this_week: { week: number; opponent: string; win_pct: number }; by_final_wins: unknown[] };
      expect(focus.team_name).toBe("Alice's Avengers");
      expect(focus.this_week.week).toBe(5);
      expect(focus.this_week.opponent).toContain("Bobby Tables");
      expect(focus.this_week.win_pct).toBeGreaterThan(99);
      expect(focus.by_final_wins.length).toBeGreaterThan(0);

      const notes = (d.notes as string[]).join(" ");
      expect(notes).toContain("divisions");
      expect(notes).toContain("week(s) 13"); // opponents drawn at random
      expect(notes).toContain("week(s) 14"); // nearest week's projections

      const leagueWide = await o.call("get_playoff_odds", { league_id: LEAGUE_ID });
      expect(leagueWide.data!.focus).toBeUndefined();
    } finally {
      await o.close();
    }
  });

  it("get_playoff_odds explains when there is nothing to simulate", async () => {
    const over = await connectedClient({ [`/league/${LEAGUE_ID}`]: { ...league, settings: { ...league.settings, last_scored_leg: 14 } } });
    try {
      const res = await over.call("get_playoff_odds", { league_id: LEAGUE_ID });
      expect(res.data).toMatchObject({ status: "regular_season_over" });
      expect((res.data!.seeds as { team_name: string }[]).map((s) => s.team_name)).toEqual(["Team Bobby Tables", "Alice's Avengers"]);
    } finally {
      await over.close();
    }
    const early = await connectedClient({ [`/league/${LEAGUE_ID}`]: { ...league, status: "pre_draft" } });
    try {
      const res = await early.call("get_playoff_odds", { league_id: LEAGUE_ID });
      expect(res.result.isError).toBe(true);
      expect(res.text).toContain("draft");
    } finally {
      await early.close();
    }
  });
});

describe("default user", () => {
  it("without a default, user-less calls explain what to pass", async () => {
    const leagues = await c.call("get_user_leagues");
    expect(leagues.result.isError).toBe(true);
    expect(leagues.text).toMatch(/SLEEPER_USERNAME/);
    const roster = await c.call("get_roster", { league_id: LEAGUE_ID });
    expect(roster.result.isError).toBe(true);
    expect(roster.text).toMatch(/roster_id, username, user_id or team_name/);
  });

  it("with a default, 'my' questions resolve without a selector and explicit selectors still win", async () => {
    const mine = await connectedClient({}, { defaultUser: "alice" });
    try {
      expect((await mine.call("get_user")).data).toMatchObject({ user_id: "111", username: "alice" });
      expect((await mine.call("get_user_leagues")).data).toMatchObject({ user_id: "111", count: 1 });
      expect((await mine.call("get_roster", { league_id: LEAGUE_ID })).data).toMatchObject({ manager: "Alice" });
      expect((await mine.call("get_lineup_projections", { league_id: LEAGUE_ID })).data).toMatchObject({ manager: "Alice" });
      expect((await mine.call("get_roster", { league_id: LEAGUE_ID, username: "bob" })).data).toMatchObject({ manager: "Bobby Tables" });
      const info = mine.client.getInstructions();
      expect(info).toContain('Default user: "alice"');
    } finally {
      await mine.close();
    }
  });
});

describe("error handling", () => {
  it("rejects invalid input with a validation error rather than crashing", async () => {
    const { result, text } = await c.call("get_matchups", { league_id: LEAGUE_ID, week: 99 });
    expect(result.isError).toBe(true);
    expect(text.toLowerCase()).toContain("week");
  });

  it("surfaces upstream 5xx errors after retries", async () => {
    const broken = await connectedClient({ "/state/nfl": () => ({ status: 500 }) });
    try {
      const { result, text } = await broken.call("get_nfl_state");
      expect(result.isError).toBe(true);
      expect(text).toMatch(/HTTP 500/);
    } finally {
      await broken.close();
    }
  });
});
