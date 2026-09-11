import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveSeason, resolveUserId, ToolError, type ServerContext } from "../context.js";
import { avatarUrl } from "../sleeper/client.js";
import type { League, LeagueUser, Roster } from "../sleeper/types.js";
import {
  isoDate,
  leagueCard,
  leagueType,
  num,
  points,
  record,
  rosterShape,
  scoringSummary,
  waiverType,
  type TeamRef,
} from "../format.js";
import { guard, leagueIdSchema, seasonSchema, sportSchema, userIdSchema, usernameSchema } from "./shared.js";

export function registerLeagueTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_nfl_state",
    {
      title: "NFL state",
      description:
        "Current NFL season/week as Sleeper sees it: season, season_type (pre/regular/post), week, display_week, league_season. Call this first when a question depends on 'this week' or 'this season'.",
      inputSchema: { sport: sportSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sport }) => guard(async () => ctx.client.getNflState(sport)),
  );

  server.registerTool(
    "get_user",
    {
      title: "Look up a Sleeper user",
      description: "Resolve a Sleeper username to its user_id, display name and avatar (or look up by user_id). Usernames can change; user_id is stable.",
      inputSchema: {
        username: usernameSchema,
        user_id: userIdSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ username, user_id }) =>
      guard(async () => {
        const raw = (user_id ?? username ?? "").trim();
        if (!raw) throw new ToolError("Provide username or user_id.");
        const user = await ctx.client.getUser(raw);
        return {
          user_id: user.user_id,
          username: user.username,
          display_name: user.display_name,
          avatar_url: avatarUrl(user.avatar),
          is_bot: user.is_bot ?? false,
        };
      }),
  );

  server.registerTool(
    "get_user_leagues",
    {
      title: "List a user's leagues",
      description:
        "All leagues a user is in for a season (default: current season), with league_id, scoring format, roster shape and status. Start here to find the league_id other tools need.",
      inputSchema: {
        username: usernameSchema,
        user_id: userIdSchema,
        season: seasonSchema,
        sport: sportSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ username, user_id, season, sport }) =>
      guard(async () => {
        const userId = await resolveUserId(ctx, { username, user_id });
        const resolvedSeason = await resolveSeason(ctx, season, sport);
        const leagues = await ctx.client.getUserLeagues(userId, sport, resolvedSeason);
        return {
          user_id: userId,
          season: resolvedSeason,
          count: leagues.length,
          leagues: leagues.map(leagueCard),
        };
      }),
  );

  server.registerTool(
    "get_league",
    {
      title: "League details",
      description:
        "Settings for one league: scoring format (PPR/half/standard, TE premium, pass TD value, bonuses), roster slots, league type (redraft/keeper/dynasty), waiver system and FAAB budget, playoff format, trade deadline, divisions, commissioners and season status. Set include_raw=true for the full scoring_settings and settings objects.",
      inputSchema: {
        league_id: leagueIdSchema,
        include_raw: z.boolean().default(false).describe("Include Sleeper's raw settings and scoring_settings objects."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, include_raw }) =>
      guard(async () => {
        const { league, users } = await loadLeague(ctx, league_id);
        return leagueDetails(league, users, include_raw);
      }),
  );

  server.registerTool(
    "get_league_standings",
    {
      title: "League standings",
      description:
        "Standings for a league, sorted by wins then points for: rank, team name, manager, record, points for/against, streak, waiver position, FAAB remaining, division. Also serves as the roster_id ↔ manager mapping for the league.",
      inputSchema: { league_id: leagueIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        return standings(bundle.league, bundle.rosters, bundle.teams);
      }),
  );

  server.registerTool(
    "get_league_history",
    {
      title: "League history",
      description:
        "Walk a league's previous seasons (via previous_league_id) and report each season's champion, runner-up, regular-season points leader and record holders. Great for dynasty/keeper leagues. Limited to max_seasons hops.",
      inputSchema: {
        league_id: leagueIdSchema,
        max_seasons: z.number().int().min(1).max(15).default(8).describe("How many seasons back to walk (including the given league)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, max_seasons }) =>
      guard(async () => {
        const seasons: unknown[] = [];
        let current: string | null = league_id;
        const seen = new Set<string>();
        while (current && seasons.length < max_seasons && !seen.has(current)) {
          seen.add(current);
          const bundle = await loadLeague(ctx, current);
          const bracket = await ctx.client.getWinnersBracket(current);
          const finalMatch = bracket.find((m) => m.p === 1) ?? bracket.reduce((best, m) => (!best || m.r > best.r ? m : best), undefined as (typeof bracket)[number] | undefined);
          const table = standings(bundle.league, bundle.rosters, bundle.teams).standings;
          seasons.push({
            season: bundle.league.season,
            league_id: bundle.league.league_id,
            name: bundle.league.name,
            status: bundle.league.status,
            teams: bundle.league.total_rosters,
            champion: finalMatch?.w ? teamName(bundle.teams, finalMatch.w) : null,
            runner_up: finalMatch?.l ? teamName(bundle.teams, finalMatch.l) : null,
            regular_season_leader: table[0] ? { team: table[0].team_name, manager: table[0].manager, record: table[0].record } : null,
            most_points: [...table].sort((a, b) => b.points_for - a.points_for)[0]?.team_name ?? null,
          });
          current = bundle.league.previous_league_id;
        }
        return { seasons_found: seasons.length, seasons };
      }),
  );
}

function teamName(teams: Map<number, TeamRef>, rosterId: number): string | null {
  const t = teams.get(rosterId);
  return t ? (t.manager && t.manager !== t.team_name ? `${t.team_name} (${t.manager})` : t.team_name) : `Roster ${rosterId}`;
}

export function leagueDetails(league: League, users: LeagueUser[], includeRaw: boolean) {
  const s = league.settings ?? {};
  const scoring = scoringSummary(league);
  const divisions: Record<string, string> = {};
  const meta = (league.metadata ?? {}) as Record<string, unknown>;
  for (let i = 1; i <= num(s.divisions); i++) {
    const name = meta[`division_${i}`];
    if (typeof name === "string") divisions[String(i)] = name;
  }
  const details: Record<string, unknown> = {
    league_id: league.league_id,
    name: league.name,
    season: league.season,
    status: league.status,
    type: leagueType(league),
    teams: league.total_rosters,
    scoring,
    roster_positions: league.roster_positions,
    roster_shape: rosterShape(league.roster_positions),
    bench_slots: (league.roster_positions ?? []).filter((p) => p === "BN").length,
    ir_slots: num(s.reserve_slots) || (league.roster_positions ?? []).filter((p) => p === "IR").length,
    taxi_slots: num(s.taxi_slots),
    waivers: {
      type: waiverType(league),
      faab_budget: s.waiver_type === 2 ? num(s.waiver_budget) : null,
      waiver_day_of_week: s.waiver_day_of_week ?? null,
      daily_waivers: s.daily_waivers === 1,
    },
    playoffs: {
      teams: num(s.playoff_teams),
      week_start: s.playoff_week_start ?? null,
      round_type: s.playoff_round_type ?? null,
      seed_type: s.playoff_seed_type ?? null,
    },
    trade_deadline_week: s.trade_deadline === 99 ? null : (s.trade_deadline ?? null),
    max_keepers: s.max_keepers ?? null,
    divisions: Object.keys(divisions).length ? divisions : null,
    current_week: s.leg ?? null,
    last_scored_week: s.last_scored_leg ?? null,
    draft_id: league.draft_id,
    previous_league_id: league.previous_league_id,
    commissioners: users.filter((u) => u.is_owner).map((u) => u.display_name ?? u.username),
    avatar_url: avatarUrl(league.avatar),
  };
  if (includeRaw) {
    details.raw_settings = league.settings;
    details.raw_scoring_settings = league.scoring_settings;
  }
  return details;
}

export function standings(league: League, rosters: Roster[], teams: Map<number, TeamRef>) {
  const s = league.settings ?? {};
  const faabBudget = s.waiver_type === 2 ? num(s.waiver_budget) : null;
  const meta = (league.metadata ?? {}) as Record<string, unknown>;
  const rows = rosters.map((r) => {
    const team = teams.get(r.roster_id);
    const rs = r.settings ?? {};
    const divisionName = rs.division ? (meta[`division_${rs.division}`] as string | undefined) : undefined;
    const streak = (r.metadata as Record<string, unknown> | null | undefined)?.streak;
    return {
      rank: 0,
      roster_id: r.roster_id,
      team_name: team?.team_name ?? `Roster ${r.roster_id}`,
      manager: team?.manager ?? null,
      user_id: team?.user_id ?? null,
      record: record(rs),
      wins: num(rs.wins),
      losses: num(rs.losses),
      ties: num(rs.ties),
      points_for: points(rs, "fpts"),
      points_against: points(rs, "fpts_against"),
      max_points_for: rs.ppts !== undefined ? points(rs, "ppts") : undefined,
      streak: typeof streak === "string" ? streak : undefined,
      waiver_position: rs.waiver_position ?? null,
      faab_remaining: faabBudget === null ? undefined : faabBudget - num(rs.waiver_budget_used),
      total_moves: num(rs.total_moves),
      division: divisionName ?? (rs.division ? String(rs.division) : undefined),
    };
  });
  rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.points_for - a.points_for);
  rows.forEach((row, i) => (row.rank = i + 1));
  return {
    league_id: league.league_id,
    league: league.name,
    season: league.season,
    status: league.status,
    week: s.leg ?? null,
    playoff_teams: num(s.playoff_teams) || null,
    playoff_week_start: s.playoff_week_start ?? null,
    faab_budget: faabBudget,
    standings: rows,
  };
}

export { isoDate };
