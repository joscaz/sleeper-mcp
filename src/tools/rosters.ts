import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError, hasTeamSelector, loadLeague, resolveRoster, resolveWeek, type LeagueBundle, type ServerContext } from "../context.js";
import type { BracketMatch, Matchup, Roster } from "../sleeper/types.js";
import type { PlayerRef } from "../sleeper/players.js";
import { num, points, record, round, startingSlots, teamLabel } from "../format.js";
import { guard, leagueIdSchema, teamSelectorShape, weekSchema } from "./shared.js";

export function registerRosterTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_roster",
    {
      title: "One team's roster",
      description:
        "A single team in a league, identified by username, user_id, roster_id or team_name: starters (with slot labels), bench, IR and taxi squad, all resolved to player names/positions/teams with injury flags, plus record, points and waiver/FAAB status.",
      inputSchema: { league_id: leagueIdSchema, ...teamSelectorShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, ...selector }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const roster = await resolveRoster(ctx, bundle, selector);
        return { league_id: bundle.league.league_id, league: bundle.league.name, season: bundle.league.season, ...describeRoster(ctx, bundle, roster, true) };
      }),
  );

  server.registerTool(
    "get_league_rosters",
    {
      title: "All rosters in a league",
      description:
        "Every team's roster in a league with player names resolved (starters with slots, bench, IR, taxi), owner, record and points. Use include_bench=false for a lighter response when only starters matter.",
      inputSchema: {
        league_id: leagueIdSchema,
        include_bench: z.boolean().default(true).describe("Include bench/IR/taxi players (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, include_bench }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        await ctx.players.ensureLoaded();
        const rosters = [...bundle.rosters].sort((a, b) => a.roster_id - b.roster_id).map((r) => describeRoster(ctx, bundle, r, include_bench));
        return { league_id: bundle.league.league_id, league: bundle.league.name, season: bundle.league.season, teams: rosters.length, rosters };
      }),
  );

  server.registerTool(
    "get_matchups",
    {
      title: "Weekly matchups",
      description:
        "Head-to-head matchups for a week (default: current week) with team names, scores, and each side's starters (slot, player, points) and bench. Pass username/roster_id/team_name to get just that team's matchup. Points are live during games and final afterwards.",
      inputSchema: {
        league_id: leagueIdSchema,
        week: weekSchema,
        ...teamSelectorShape,
        include_bench: z.boolean().default(false).describe("Include bench players and their points (default false)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, week, include_bench, ...selector }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const { week: resolvedWeek } = await resolveWeek(ctx, week);
        const [matchups] = await Promise.all([ctx.client.getMatchups(bundle.league.league_id, resolvedWeek), ctx.players.ensureLoaded()]);
        if (!matchups.length) {
          throw new ToolError(`No matchups for week ${resolvedWeek} in league "${bundle.league.name}" (league status: ${bundle.league.status}).`);
        }
        const wantsOne = hasTeamSelector(selector);
        const only = wantsOne ? (await resolveRoster(ctx, bundle, selector)).roster_id : undefined;
        return describeMatchups(ctx, bundle, matchups, resolvedWeek, { include_bench, onlyRosterId: only });
      }),
  );

  server.registerTool(
    "get_playoff_bracket",
    {
      title: "Playoff bracket",
      description:
        "Winners (and optionally losers/consolation) bracket with team names, round labels, results and where each slot's participants come from. Empty until the league's playoff_week_start.",
      inputSchema: {
        league_id: leagueIdSchema,
        bracket: z.enum(["winners", "losers", "both"]).default("winners").describe("Which bracket to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, bracket }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const [winners, losers] = await Promise.all([
          bracket === "losers" ? Promise.resolve([]) : ctx.client.getWinnersBracket(bundle.league.league_id),
          bracket === "winners" ? Promise.resolve([]) : ctx.client.getLosersBracket(bundle.league.league_id),
        ]);
        const out: Record<string, unknown> = {
          league_id: bundle.league.league_id,
          league: bundle.league.name,
          season: bundle.league.season,
          playoff_teams: num(bundle.league.settings?.playoff_teams) || null,
          playoff_week_start: bundle.league.settings?.playoff_week_start ?? null,
        };
        if (bracket !== "losers") out.winners_bracket = describeBracket(bundle, winners, "winners");
        if (bracket !== "winners") out.losers_bracket = describeBracket(bundle, losers, "losers");
        return out;
      }),
  );
}

// ---------------------------------------------------------------------------
// Helpers shared with other tool modules
// ---------------------------------------------------------------------------

export interface SlotPlayer extends PlayerRef {
  slot?: string;
  pts?: number;
}

/** Pair starters with their slot label from the league's roster_positions. */
export function labelStarters(ctx: ServerContext, bundle: LeagueBundle, starters: string[] | null | undefined, pointsByPlayer?: Record<string, number> | null): SlotPlayer[] {
  const slots = startingSlots(bundle.league);
  return (starters ?? []).map((id, i) => {
    const slot = slots[i] ?? "FLEX";
    if (!id || id === "0") return { id: "0", name: "(empty)", pos: null, team: null, slot };
    const ref: SlotPlayer = { ...ctx.players.ref(id), slot };
    const pts = pointsByPlayer?.[id];
    if (typeof pts === "number") ref.pts = round(pts, 2);
    return ref;
  });
}

export function describeRoster(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, includeBench: boolean) {
  const team = bundle.teams.get(roster.roster_id);
  const starterIds = new Set((roster.starters ?? []).filter((id) => id && id !== "0"));
  const reserve = roster.reserve ?? [];
  const taxi = roster.taxi ?? [];
  const benchIds = (roster.players ?? []).filter((id) => !starterIds.has(id) && !reserve.includes(id) && !taxi.includes(id));
  const s = roster.settings ?? {};
  const faabBudget = bundle.league.settings?.waiver_type === 2 ? num(bundle.league.settings.waiver_budget) : null;
  const out: Record<string, unknown> = {
    roster_id: roster.roster_id,
    team_name: team?.team_name ?? `Roster ${roster.roster_id}`,
    manager: team?.manager ?? null,
    user_id: roster.owner_id,
    co_owners: roster.co_owners?.length ? roster.co_owners : undefined,
    record: record(s),
    points_for: points(s, "fpts"),
    points_against: points(s, "fpts_against"),
    waiver_position: s.waiver_position ?? null,
    faab_remaining: faabBudget === null ? undefined : faabBudget - num(s.waiver_budget_used),
    starters: labelStarters(ctx, bundle, roster.starters),
  };
  if (includeBench) {
    out.bench = ctx.players.refs(benchIds);
    if (reserve.length) out.ir = ctx.players.refs(reserve);
    if (taxi.length) out.taxi = ctx.players.refs(taxi);
  }
  out.roster_size = (roster.players ?? []).length;
  return out;
}

export function describeMatchups(
  ctx: ServerContext,
  bundle: LeagueBundle,
  matchups: Matchup[],
  week: number,
  options: { include_bench?: boolean; onlyRosterId?: number } = {},
) {
  const groups = new Map<number, Matchup[]>();
  const byes: Matchup[] = [];
  for (const m of matchups) {
    if (m.matchup_id === null || m.matchup_id === undefined) byes.push(m);
    else groups.set(m.matchup_id, [...(groups.get(m.matchup_id) ?? []), m]);
  }

  const describeSide = (m: Matchup) => {
    const team = bundle.teams.get(m.roster_id);
    const pts = m.players_points ?? undefined;
    const starterIds = new Set((m.starters ?? []).filter((id) => id && id !== "0"));
    const side: Record<string, unknown> = {
      roster_id: m.roster_id,
      team_name: team?.team_name ?? `Roster ${m.roster_id}`,
      manager: team?.manager ?? null,
      points: round(num(m.custom_points ?? m.points), 2),
      starters: labelStarters(ctx, bundle, m.starters, pts),
    };
    if (m.custom_points !== null && m.custom_points !== undefined) side.custom_points_override = true;
    if (options.include_bench) {
      side.bench = (m.players ?? [])
        .filter((id) => !starterIds.has(id))
        .map((id) => {
          const ref: SlotPlayer = ctx.players.ref(id);
          const p = pts?.[id];
          if (typeof p === "number") ref.pts = round(p, 2);
          return ref;
        });
    }
    return side;
  };

  let pairs = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  if (options.onlyRosterId !== undefined) pairs = pairs.filter(([, ms]) => ms.some((m) => m.roster_id === options.onlyRosterId));

  const described = pairs.map(([matchupId, ms]) => {
    const sides = ms.map(describeSide) as { points: number; team_name: string }[];
    const [a, b] = sides;
    const out: Record<string, unknown> = { matchup_id: matchupId, teams: sides };
    if (a && b) {
      out.margin = round(Math.abs(a.points - b.points), 2);
      out.leader = a.points === b.points ? (a.points > 0 ? "tied" : null) : a.points > b.points ? a.team_name : b.team_name;
    }
    return out;
  });

  const result: Record<string, unknown> = {
    league_id: bundle.league.league_id,
    league: bundle.league.name,
    season: bundle.league.season,
    week,
    matchups: described,
  };
  const relevantByes = options.onlyRosterId === undefined ? byes : byes.filter((m) => m.roster_id === options.onlyRosterId);
  if (relevantByes.length) result.byes = relevantByes.map(describeSide);
  if (options.onlyRosterId !== undefined && described.length === 0 && relevantByes.length === 0) {
    result.note = `Roster ${options.onlyRosterId} has no matchup in week ${week}.`;
  }
  return result;
}

export function describeBracket(bundle: LeagueBundle, matches: BracketMatch[], kind: "winners" | "losers") {
  if (!matches.length) return { rounds: 0, matches: [] };
  const maxRound = Math.max(...matches.map((m) => m.r));
  const label = (m: BracketMatch): string => {
    if (kind === "winners") {
      if (m.p === 1) return "Championship";
      if (m.p === 3) return "3rd place game";
      if (m.p === 5) return "5th place game";
      if (m.p === 7) return "7th place game";
      if (m.r === maxRound) return "Final";
      if (m.r === maxRound - 1 && !m.p) return "Semifinal";
      if (m.r === maxRound - 2 && !m.p) return "Quarterfinal";
    } else {
      if (m.p === 1) return "Toilet bowl final";
      if (m.p) return `Consolation, place ${m.p}`;
    }
    return `Round ${m.r}`;
  };
  const source = (from: BracketMatch["t1_from"]): string | null => {
    if (!from) return null;
    if (from.w !== undefined) return `winner of match ${from.w}`;
    if (from.l !== undefined) return `loser of match ${from.l}`;
    return null;
  };
  return {
    rounds: maxRound,
    matches: matches
      .slice()
      .sort((a, b) => a.r - b.r || a.m - b.m)
      .map((m) => ({
        round: m.r,
        match: m.m,
        label: label(m),
        team1: teamLabel(bundle.teams, m.t1) ?? source(m.t1_from) ?? "TBD",
        team2: teamLabel(bundle.teams, m.t2) ?? source(m.t2_from) ?? "TBD",
        winner: teamLabel(bundle.teams, m.w),
        loser: teamLabel(bundle.teams, m.l),
        plays_for_place: m.p ?? undefined,
      })),
  };
}
