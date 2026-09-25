import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, resolveWeek, ToolError, type LeagueBundle, type ServerContext } from "../context.js";
import { TTL } from "../sleeper/client.js";
import { isTeamDefense } from "../sleeper/players.js";
import type { League, NflState, Roster, StatLine, StatMap } from "../sleeper/types.js";
import { keyStats, num, round, scoreStatLine, SLOT_ELIGIBILITY, startingSlots } from "../format.js";
import { hasKickedOff, loadWeekGames, nflTeam, type GameState, type TeamGame, type WeekGames } from "../games.js";
import { guard, leagueIdSchema, positionSchema, seasonSchema, teamSelectorShape, weekSchema } from "./shared.js";
import type { SlotPlayer } from "./rosters.js";

const scoringSchema = z
  .enum(["ppr", "half_ppr", "std", "league"])
  .default("ppr")
  .describe("Which fantasy point total to report: Sleeper's ppr / half_ppr / std, or 'league' to score with a league's exact scoring_settings (requires league_id).");

const seasonTypeSchema = z.enum(["regular", "post", "pre"]).default("regular");

export function registerStatTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_projections",
    {
      title: "Player projections",
      description:
        "Sleeper's weekly (or full-season when week=0) fantasy projections. Filter by player_ids, position or a league (league_id + optional team to project one roster). Returns projected fantasy points (PPR/half/standard, or exact league scoring when scoring='league') plus key projected stats. Sorted by projected points.",
      inputSchema: {
        week: z.number().int().min(0).max(22).optional().describe("Week (default: current week). Use 0 for season-long projections."),
        season: seasonSchema,
        season_type: seasonTypeSchema,
        player_ids: z.array(z.string()).max(200).optional().describe("Specific player_ids to return."),
        position: positionSchema,
        league_id: z.string().trim().min(1).optional().describe("Score with this league's settings and/or restrict to its rosters (use with team selector)."),
        ...teamSelectorShape,
        scoring: scoringSchema,
        limit: z.number().int().min(1).max(300).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(() => statsOrProjections(ctx, "projections", args)),
  );

  server.registerTool(
    "get_player_stats",
    {
      title: "Player stats (actuals)",
      description:
        "Actual fantasy production for a week (or the full season when week=0): fantasy points in PPR/half/standard or exact league scoring, plus key box-score stats. Filter by player_ids, position, or a league/team. Sorted by points.",
      inputSchema: {
        week: z.number().int().min(0).max(22).optional().describe("Week (default: current week). Use 0 for season totals."),
        season: seasonSchema,
        season_type: seasonTypeSchema,
        player_ids: z.array(z.string()).max(200).optional().describe("Specific player_ids to return."),
        position: positionSchema,
        league_id: z.string().trim().min(1).optional().describe("Score with this league's settings and/or restrict to its rosters (use with team selector)."),
        ...teamSelectorShape,
        scoring: scoringSchema,
        limit: z.number().int().min(1).max(300).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(() => statsOrProjections(ctx, "stats", args)),
  );

  server.registerTool(
    "get_lineup_projections",
    {
      title: "Start/sit: projected lineup",
      description:
        "For one team in a league: current starters with projected points under the league's exact scoring, an optimal projected lineup respecting slot eligibility, suggested swaps, and bye/injury warnings. Once the week's games start, a player whose game has kicked off is locked in his slot and his pts are the points he has scored (plus a projection for the rest of a live game), so totals are projected finals and suggestions only move players who have not played yet. Uses Sleeper's projections; treat as a baseline, not gospel.",
      inputSchema: {
        league_id: leagueIdSchema,
        ...teamSelectorShape,
        week: weekSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, week, ...selector }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const { week: resolvedWeek, state } = await resolveWeek(ctx, week);
        const season = bundle.league.season;
        const [projections] = await Promise.all([ctx.client.getProjections("nfl", seasonTypeFor(state, season), season, resolvedWeek), ctx.players.ensureLoaded()]);
        const roster = await resolveRoster(ctx, bundle, selector);
        const live = await loadLiveWeek(ctx, bundle, roster, resolvedWeek, state);
        return lineupAnalysis(ctx, bundle, roster.roster_id, roster.players ?? [], roster.starters ?? [], projections, resolvedWeek, live);
      }),
  );
}

/** What has already happened in a week for one roster: each player's game state and the points scored so far. */
export interface LiveWeek {
  games: WeekGames;
  /** Points scored so far under the league's scoring, for players whose game has kicked off. */
  scored: Map<string, number>;
}

async function loadLiveWeek(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, week: number, state: NflState): Promise<LiveWeek> {
  const season = bundle.league.season;
  const games = await loadWeekGames(ctx, season, week, state);
  const scored = new Map<string, number>();
  const started = (roster.players ?? []).filter((id) => hasKickedOff(games.game(nflTeam(ctx, id))));
  if (!started.length) return { games, scored };

  // Sleeper's matchup points are what the league counts; box scores under the league's scoring cover anyone missing there.
  let official: Record<string, number> = {};
  try {
    const matchups = await ctx.client.getMatchups(bundle.league.league_id, week);
    official = matchups.find((m) => m.roster_id === roster.roster_id)?.players_points ?? {};
  } catch (err) {
    ctx.log(`matchups unavailable (${(err as Error).message}); scoring from box scores`);
  }
  let box: StatMap = {};
  if (started.some((id) => typeof official[id] !== "number")) {
    try {
      box = await ctx.client.getStats("nfl", "regular", season, week, { ttlMs: TTL.liveStats });
    } catch (err) {
      ctx.log(`box scores unavailable (${(err as Error).message})`);
    }
  }
  for (const id of started) {
    const pts = official[id];
    scored.set(id, typeof pts === "number" ? pts : scoreStatLine(box[id] ?? null, bundle.league.scoring_settings));
  }
  return { games, scored };
}

type StatsArgs = {
  week?: number;
  season?: string | number;
  season_type: "regular" | "post" | "pre";
  player_ids?: string[];
  position?: string;
  league_id?: string;
  username?: string;
  user_id?: string;
  roster_id?: number;
  team_name?: string;
  scoring: "ppr" | "half_ppr" | "std" | "league";
  limit: number;
};

async function statsOrProjections(ctx: ServerContext, kind: "stats" | "projections", args: StatsArgs) {
  const { week: currentWeek, state } = await resolveWeek(ctx, args.week === 0 ? undefined : args.week);
  const week = args.week === 0 ? undefined : (args.week ?? currentWeek);
  const season = args.season !== undefined && String(args.season).trim() !== "" ? String(args.season).trim() : state.league_season ?? state.season;

  let bundle: LeagueBundle | undefined;
  let restrictTo: Set<string> | undefined;
  if (args.league_id) {
    bundle = await loadLeague(ctx, args.league_id);
    const wantsTeam = args.roster_id !== undefined || args.username || args.user_id || args.team_name;
    if (wantsTeam) {
      const roster = await resolveRoster(ctx, bundle, args);
      restrictTo = new Set(roster.players ?? []);
    }
  } else if (args.scoring === "league") {
    throw new ToolError("scoring='league' requires league_id.");
  }

  const fetcher = kind === "stats" ? ctx.client.getStats.bind(ctx.client) : ctx.client.getProjections.bind(ctx.client);
  const [map] = await Promise.all([fetcher("nfl", args.season_type, season, week), ctx.players.ensureLoaded()]);
  if (!Object.keys(map).length) {
    throw new ToolError(`No ${kind} available for ${season} ${args.season_type} ${week === undefined ? "season" : `week ${week}`}.`);
  }

  const ids = args.player_ids ? new Set(args.player_ids) : undefined;
  const rows: Record<string, unknown>[] = [];
  for (const [playerId, line] of Object.entries(map)) {
    if (!line) continue;
    if (ids && !ids.has(playerId)) continue;
    if (restrictTo && !restrictTo.has(playerId)) continue;
    const ref = ctx.players.ref(playerId);
    if (args.position && ref.pos !== args.position) continue;
    const pts = fantasyPoints(line, args.scoring, bundle?.league);
    if (pts === 0 && !ids && !restrictTo && kind === "projections") continue; // skip the long tail of zero projections
    rows.push({ ...ref, pts, ...(week === undefined ? { gp: num(line.gp) || undefined } : {}), stats: keyStats(line, ref.pos) });
  }
  rows.sort((a, b) => (b.pts as number) - (a.pts as number));

  return {
    kind,
    season,
    season_type: args.season_type,
    week: week ?? "season",
    scoring: args.scoring === "league" && bundle ? `league (${bundle.league.name})` : args.scoring,
    ...(restrictTo ? { league_id: bundle?.league.league_id, team_filter: true } : {}),
    total: rows.length,
    returned: Math.min(rows.length, args.limit),
    players: rows.slice(0, args.limit),
  };
}

function seasonTypeFor(state: NflState, season: string): string {
  if (season !== state.season) return "regular";
  return state.season_type === "post" ? "regular" : state.season_type === "pre" ? "regular" : state.season_type;
}

export function fantasyPoints(line: StatLine, scoring: "ppr" | "half_ppr" | "std" | "league", league?: League): number {
  if (scoring === "league" && league) return scoreStatLine(line, league.scoring_settings);
  const key = scoring === "ppr" ? "pts_ppr" : scoring === "half_ppr" ? "pts_half_ppr" : "pts_std";
  const v = line[key];
  if (typeof v === "number") return round(v, 2);
  if (league) return scoreStatLine(line, league.scoring_settings);
  return 0;
}

/**
 * Greedy-but-correct optimal lineup: fill the most restrictive slots first, then flex slots,
 * always choosing the highest projected eligible player. Returns player ids aligned with the
 * league's starting slots (null where nobody eligible is left).
 */
export function optimalStarters(
  ctx: ServerContext,
  league: Pick<League, "roster_positions">,
  candidates: Iterable<string>,
  projected: Map<string, number>,
): (string | null)[] {
  const slots = startingSlots(league);
  const eligible = (playerId: string, slot: string): boolean => {
    const p = ctx.players.raw(playerId);
    const positions = p?.fantasy_positions ?? (p?.position ? [p.position] : isTeamDefense(playerId) ? ["DEF"] : []);
    const allowed = SLOT_ELIGIBILITY[slot] ?? [slot];
    return positions.some((pos) => allowed.includes(pos));
  };

  // Order slots by how many positions they accept (specific first), keep original index for output.
  const slotOrder = slots.map((slot, index) => ({ slot, index, breadth: (SLOT_ELIGIBILITY[slot] ?? [slot]).length })).sort((a, b) => a.breadth - b.breadth);
  const available = new Set(candidates);
  const optimal: (string | null)[] = new Array(slots.length).fill(null);
  for (const { slot, index } of slotOrder) {
    let best: string | null = null;
    let bestPts = -Infinity;
    for (const id of available) {
      if (!eligible(id, slot)) continue;
      const pts = projected.get(id) ?? 0;
      if (pts > bestPts) {
        best = id;
        bestPts = pts;
      }
    }
    if (best) {
      optimal[index] = best;
      available.delete(best);
    }
  }
  return optimal;
}

/** A lineup entry: pts is the player's projected total for the week, including anything already scored. */
type LineupPlayer = SlotPlayer & { status?: GameState; scored?: number };

/**
 * Current vs optimal projected lineup for one roster, with suggested swaps and warnings. A player whose
 * game has kicked off counts the points he has scored plus his projection for the part of the game still
 * to play, and stays where he is: Sleeper locks players at kickoff, so only players still to play move.
 */
export function lineupAnalysis(
  ctx: ServerContext,
  bundle: LeagueBundle,
  rosterId: number,
  playerIds: string[],
  currentStarters: string[],
  projections: StatMap,
  week: number,
  live: LiveWeek,
) {
  const league = bundle.league;
  const scoring = league.scoring_settings;
  const slots = startingSlots(league);
  const team = bundle.teams.get(rosterId);

  const gameOf = new Map<string, TeamGame>();
  const projected = new Map<string, number>();
  for (const id of playerIds) {
    const game = live.games.game(nflTeam(ctx, id));
    gameOf.set(id, game);
    projected.set(id, (live.scored.get(id) ?? 0) + scoreStatLine(projections[id] ?? null, scoring) * game.remaining);
  }
  const kickedOff = new Set(playerIds.filter((id) => hasKickedOff(gameOf.get(id)!)));
  const isLocked = (id: string | null | undefined): id is string => Boolean(id && kickedOff.has(id));

  // Starters whose game has kicked off keep their slot; every other slot is refilled from players still to play.
  const reserve = bundle.rosters.find((r) => r.roster_id === rosterId)?.reserve ?? [];
  const open = slots.map((slot, index) => ({ slot, index })).filter(({ index }) => !isLocked(currentStarters[index]));
  const picks = optimalStarters(
    ctx,
    { roster_positions: open.map((s) => s.slot) },
    playerIds.filter((id) => !reserve.includes(id) && !kickedOff.has(id)),
    projected,
  );
  const optimal: (string | null)[] = slots.map((_, i) => {
    const id = currentStarters[i];
    return isLocked(id) ? id : null;
  });
  open.forEach(({ index }, k) => {
    optimal[index] = picks[k] ?? null;
  });

  const describe = (id: string | null, slot: string): LineupPlayer => {
    if (!id || id === "0") return { id: "0", name: "(empty)", pos: null, team: null, slot, pts: 0 };
    const out: LineupPlayer = { ...ctx.players.ref(id), slot, pts: round(projected.get(id) ?? 0, 2) };
    const state = gameOf.get(id)?.state;
    if (state && state !== "yet_to_play") out.status = state;
    if (kickedOff.has(id)) out.scored = round(live.scored.get(id) ?? 0, 2);
    return out;
  };

  const current = slots.map((slot, i) => describe(currentStarters[i] ?? null, slot));
  const best = slots.map((slot, i) => describe(optimal[i] ?? null, slot));
  const currentTotal = round(current.reduce((sum, p) => sum + (p.pts ?? 0), 0), 2);
  const optimalTotal = round(best.reduce((sum, p) => sum + (p.pts ?? 0), 0), 2);
  const lockedStarters = current.filter((p) => kickedOff.has(p.id)).length;

  const currentIds = new Set(currentStarters.filter((id) => id && id !== "0"));
  const optimalIds = new Set(optimal.filter((id): id is string => Boolean(id)));
  const sit = [...currentIds].filter((id) => !optimalIds.has(id)).map((id) => describe(id, "-"));
  const start = [...optimalIds].filter((id) => !currentIds.has(id)).map((id) => describe(id, "-"));

  const warnings: string[] = [];
  for (const p of current) {
    if (p.id === "0") warnings.push(`Empty ${p.slot} slot.`);
    else if (kickedOff.has(p.id)) continue; // already playing or played: nothing left to change
    else if (p.status === "bye") warnings.push(`${p.name} (${p.slot}) is on bye.`);
    else if (p.status === "no_game") warnings.push(`${p.name} (${p.slot}) has no game this week.`);
    else if (p.inj && /out|ir|doubtful|sus|pup|nfi/i.test(p.inj)) warnings.push(`${p.name} (${p.slot}) is listed ${p.inj}.`);
    else if ((p.pts ?? 0) === 0 && !projections[p.id]) warnings.push(`${p.name} (${p.slot}) has no projection this week (bye or inactive?).`);
  }

  const bench = playerIds
    .filter((id) => !currentIds.has(id))
    .map((id) => describe(id, "BN"))
    .sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0));

  return {
    league_id: league.league_id,
    league: league.name,
    week,
    roster_id: rosterId,
    team_name: team?.team_name ?? `Roster ${rosterId}`,
    manager: team?.manager ?? null,
    scoring: "league",
    game_status_source: live.games.source,
    ...(lockedStarters ? { points_so_far: round(current.reduce((sum, p) => sum + (p.scored ?? 0), 0), 2) } : {}),
    current_lineup: current,
    current_projected_total: currentTotal,
    optimal_lineup: best,
    optimal_projected_total: optimalTotal,
    projected_gain: round(optimalTotal - currentTotal, 2),
    suggested_changes: start.length || sit.length ? { start, sit } : null,
    ...(lockedStarters
      ? {
          note: `${lockedStarters} starter(s) have kicked off: they stay in their slots and their pts include points already scored (plus a projection for the rest of a live game). Suggested changes only move players who have not played yet.`,
        }
      : {}),
    warnings,
    bench,
  };
}
