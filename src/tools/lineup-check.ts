/**
 * check_lineups: "is any of my lineups broken this week?" in one call, across every league a manager is in.
 *
 * Flags starters who will score zero (empty slot, bye, no game, Out/IR/suspended) or are at risk (Doubtful, no
 * projection), and for each one suggests the best healthy bench player who can fill that slot and has not played
 * yet. The zero-point fixes come back as moves set_lineup accepts as-is. Read-only: it never changes a lineup.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NO_USER_HINT, loadLeague, resolveUserId, resolveWeek, ToolError, type ServerContext } from "../context.js";
import { SLOT_ELIGIBILITY, teamLabel } from "../format.js";
import { isTeamDefense, type PlayerRef } from "../sleeper/players.js";
import type { League, Matchup, NflState, StatMap } from "../sleeper/types.js";
import { freshenRoster } from "./account.js";
import { lineupAnalysis, loadLiveWeek, seasonTypeFor } from "./stats.js";
import { guard, userIdSchema, usernameSchema, weekSchema } from "./shared.js";

/** Injury designations that mean the player will not play: Out, IR, Sus, PUP, NFI(-R/-A), NA, DNR, COV. */
const OUT_RE = /^(out|ir|sus|pup|nfi|na|dnr|cov)\b/i;
const DOUBTFUL_RE = /^doubtful\b/i;

type Impact = "scores_zero" | "at_risk";
type Issue = "empty" | "bye" | "no_game" | "out" | "doubtful" | "no_projection";
type LeagueStatusLabel = "needs_fix" | "at_risk" | "ok";

/** A lineup entry as lineupAnalysis describes it. */
type Entry = PlayerRef & { slot?: string; pts?: number; status?: string; scored?: number };

interface Problem {
  slot: string;
  issue: Issue;
  impact: Impact;
  detail: string;
  player: Entry | null;
  replacement: Entry | null;
  no_replacement?: string;
}

interface Move {
  start: string;
  bench?: string;
  slot?: string;
}

interface LeagueReport {
  league_id: string;
  league: string;
  team: string | null;
  status: LeagueStatusLabel;
  projected_total: number;
  /** Extra points a full start/sit re-optimisation would add (see get_lineup_projections). */
  optimal_gain: number;
  problems?: Problem[];
  set_lineup?: { league_id: string; moves: Move[] };
}

interface Skipped {
  league_id: string;
  league: string | null;
  reason: string;
}

interface CheckArgs {
  username?: string;
  user_id?: string;
  week?: number;
  league_ids?: string[];
}

export function registerLineupCheckTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "check_lineups",
    {
      title: "Lineup check across all leagues",
      description:
        "Checks every in-season league a manager is in for this week's lineup problems: starters who will score zero (empty slot, bye, no game, Out/IR/suspended) and starters at risk (Doubtful, no projection). Questionable players are not flagged. For each problem it suggests the highest-projected healthy bench player who can play that slot and whose game has not started, and returns the zero-point fixes as ready-made set_lineup arguments per league. Starters whose game has kicked off are locked and skipped; best ball leagues are skipped. Also reports optimal_gain, the points a full start/sit re-optimisation would add (get_lineup_projections has the details).",
      inputSchema: {
        username: usernameSchema.describe("Manager to check. Omit to use the server's default user, or the logged-in Sleeper account."),
        user_id: userIdSchema,
        week: weekSchema,
        league_ids: z.array(z.string().trim().min(1)).max(50).optional().describe("Only check these leagues (default: every NFL league the manager is in this season)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(() => checkLineups(ctx, args)),
  );
}

async function checkLineups(ctx: ServerContext, args: CheckArgs) {
  const userId = await resolveCheckUser(ctx, args);
  const { week, state } = await resolveWeek(ctx, args.week);
  const season = state.league_season ?? state.season;
  const [leagues] = await Promise.all([ctx.client.getUserLeagues(userId, "nfl", season), ctx.players.ensureLoaded()]);

  const wanted = args.league_ids?.length ? new Set(args.league_ids) : null;
  const skipped: Skipped[] = [];
  if (wanted) {
    for (const id of wanted) {
      if (!leagues.some((l) => l.league_id === id)) skipped.push({ league_id: id, league: null, reason: `not one of this manager's ${season} leagues` });
    }
  }
  const toCheck: League[] = [];
  for (const league of leagues) {
    if (wanted && !wanted.has(league.league_id)) continue;
    const reason = skipReason(league);
    if (reason) skipped.push({ league_id: league.league_id, league: league.name, reason });
    else toCheck.push(league);
  }

  const projections: StatMap = toCheck.length ? await ctx.client.getProjections("nfl", seasonTypeFor(state, season), season, week) : {};
  const outcomes = await Promise.all(
    toCheck.map(async (league): Promise<LeagueReport | Skipped> => {
      try {
        return await checkLeague(ctx, league, userId, week, state, projections);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { league_id: league.league_id, league: league.name, reason: `could not be checked: ${message}` };
      }
    }),
  );

  const reports: LeagueReport[] = [];
  for (const outcome of outcomes) {
    if ("reason" in outcome) skipped.push(outcome);
    else reports.push(outcome);
  }
  const order: Record<LeagueStatusLabel, number> = { needs_fix: 0, at_risk: 1, ok: 2 };
  reports.sort((a, b) => order[a.status] - order[b.status] || a.league.localeCompare(b.league));

  const problems = reports.flatMap((r) => r.problems ?? []);
  const zero = problems.filter((p) => p.impact === "scores_zero");
  const fixable = zero.filter((p) => p.replacement).length;
  const counts = { needs_fix: 0, at_risk: 0, ok: 0 };
  for (const r of reports) counts[r.status]++;

  return {
    user_id: userId,
    season,
    week,
    leagues_checked: reports.length,
    ...counts,
    summary: summarize(reports.length, counts, zero.length, fixable, problems.length - zero.length),
    leagues: reports,
    skipped,
    ...(reports.some((r) => r.set_lineup) ? { next_step: nextStep(ctx) } : {}),
    ...(ctx.auth ? {} : { note: "Lineups come from Sleeper's public API, which can trail a change made in the last minute or two." }),
  };
}

async function checkLeague(ctx: ServerContext, league: League, userId: string, week: number, state: NflState, projections: StatMap): Promise<LeagueReport | Skipped> {
  const bundle = await loadLeague(ctx, league.league_id);
  const own = bundle.rosters.find((r) => r.owner_id === userId || r.co_owners?.includes(userId));
  if (!own) return { league_id: league.league_id, league: league.name, reason: "this manager has no team here" };

  // In the playoffs, eliminated teams and teams on a bye have no matchup: their lineup does not count.
  const playoffStart = Number(bundle.league.settings?.playoff_week_start) || 0;
  if (playoffStart && week >= playoffStart) {
    let matchups: Matchup[] = [];
    try {
      matchups = await ctx.client.getMatchups(league.league_id, week);
    } catch (err) {
      ctx.log(`matchups unavailable for ${league.league_id} (${(err as Error).message}); checking the lineup anyway`);
    }
    const mine = matchups.find((m) => m.roster_id === own.roster_id);
    if (matchups.length && (!mine || mine.matchup_id === null || mine.matchup_id === undefined)) {
      return { league_id: league.league_id, league: league.name, reason: `no matchup in week ${week} (eliminated or on a playoff bye)` };
    }
  }

  const roster = await freshenRoster(ctx, bundle, own);
  const live = await loadLiveWeek(ctx, bundle, roster, week, state);
  const analysis = lineupAnalysis(ctx, bundle, roster.roster_id, roster.players ?? [], roster.starters ?? [], projections, week, live);

  const problems: Problem[] = [];
  for (const entry of analysis.current_lineup as Entry[]) {
    const found = diagnose(entry, projections);
    if (found) problems.push({ slot: entry.slot ?? "?", ...found, player: entry.id === "0" ? null : entry, replacement: null });
  }

  // Bench players who can step in: not on IR/taxi, game not started, healthy, and projected to score.
  const blocked = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])]);
  const pool = (analysis.bench as Entry[]).filter(
    (b) => !blocked.has(b.id) && !b.status && !OUT_RE.test(b.inj ?? "") && !DOUBTFUL_RE.test(b.inj ?? "") && (b.pts ?? 0) > 0,
  );
  const used = new Set<string>();
  // Zero-point problems pick first, and narrow slots (TE, K) before wide ones (FLEX, SUPER_FLEX).
  const breadth = (slot: string) => (SLOT_ELIGIBILITY[slot] ?? [slot]).length;
  const queue = [...problems].sort((a, b) => Number(a.impact !== "scores_zero") - Number(b.impact !== "scores_zero") || breadth(a.slot) - breadth(b.slot));
  for (const problem of queue) {
    const best = pool.filter((b) => !used.has(b.id) && canPlay(ctx, b.id, problem.slot)).sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0))[0];
    if (best) {
      problem.replacement = { id: best.id, name: best.name, pos: best.pos, team: best.team, ...(best.inj ? { inj: best.inj } : {}), pts: best.pts ?? 0 };
      used.add(best.id);
    } else {
      problem.no_replacement = `No healthy bench player who can play ${problem.slot} and has not played yet. Look at get_free_agents.`;
    }
  }

  const moves: Move[] = problems
    .filter((p) => p.impact === "scores_zero" && p.replacement)
    .map((p) => (p.player ? { start: p.replacement!.id, bench: p.player.id } : { start: p.replacement!.id, slot: p.slot }));

  const status: LeagueStatusLabel = problems.some((p) => p.impact === "scores_zero") ? "needs_fix" : problems.length ? "at_risk" : "ok";
  return {
    league_id: league.league_id,
    league: league.name,
    team: teamLabel(bundle.teams, roster.roster_id),
    status,
    projected_total: analysis.current_projected_total,
    optimal_gain: analysis.projected_gain,
    ...(problems.length ? { problems } : {}),
    ...(moves.length ? { set_lineup: { league_id: league.league_id, moves } } : {}),
  };
}

/** What is wrong with one starter, or null when nothing is (or nothing can be changed: his game has kicked off). */
function diagnose(entry: Entry, projections: StatMap): { issue: Issue; impact: Impact; detail: string } | null {
  if (entry.id === "0") return { issue: "empty", impact: "scores_zero", detail: `Empty ${entry.slot} slot.` };
  if (entry.status === "final" || entry.status === "playing") return null;
  if (entry.status === "bye") return { issue: "bye", impact: "scores_zero", detail: `${entry.name} is on bye.` };
  if (entry.status === "no_game") return { issue: "no_game", impact: "scores_zero", detail: `${entry.name} has no game this week.` };
  if (entry.inj && OUT_RE.test(entry.inj)) return { issue: "out", impact: "scores_zero", detail: `${entry.name} is listed ${entry.inj}.` };
  if (entry.inj && DOUBTFUL_RE.test(entry.inj)) return { issue: "doubtful", impact: "at_risk", detail: `${entry.name} is listed Doubtful.` };
  if ((entry.pts ?? 0) === 0 && !projections[entry.id]) return { issue: "no_projection", impact: "at_risk", detail: `${entry.name} has no projection this week (inactive?).` };
  return null;
}

function canPlay(ctx: ServerContext, playerId: string, slot: string): boolean {
  const p = ctx.players.raw(playerId);
  const positions = p?.fantasy_positions ?? (p?.position ? [p.position] : isTeamDefense(playerId) ? ["DEF"] : []);
  const allowed = SLOT_ELIGIBILITY[slot] ?? [slot];
  return positions.some((pos) => allowed.includes(pos));
}

function skipReason(league: League): string | null {
  if (Number(league.settings?.best_ball) === 1) return "best ball league: Sleeper sets the lineup automatically";
  if (league.status === "in_season" || league.status === "post_season") return null;
  if (league.status === "pre_draft") return "has not drafted yet";
  if (league.status === "drafting") return "draft in progress";
  if (league.status === "complete") return "season is over";
  return `league status is ${league.status}`;
}

/** Explicit selector, then the server's default user, then the logged-in Sleeper account. */
async function resolveCheckUser(ctx: ServerContext, args: CheckArgs): Promise<string> {
  if (args.user_id || args.username || ctx.defaultUser) return resolveUserId(ctx, args);
  const sessionUser = ctx.auth?.userId;
  if (sessionUser) return sessionUser;
  throw new ToolError(NO_USER_HINT);
}

function summarize(checked: number, counts: Record<LeagueStatusLabel, number>, zero: number, fixable: number, risky: number): string {
  if (!checked) return "No in-season leagues to check.";
  if (!counts.needs_fix && !counts.at_risk) return `All ${checked} lineup(s) are set: no empty slots, byes or ruled-out starters.`;
  const parts: string[] = [];
  if (zero) parts.push(`${zero} starter slot(s) will score zero in ${counts.needs_fix} league(s), ${fixable} fixable from the bench`);
  if (risky) parts.push(`${risky} starter(s) at risk`);
  return `${parts.join("; ")}.`;
}

function nextStep(ctx: ServerContext): string {
  if (ctx.allowWrites) return "To apply the zero-point fixes, confirm with the manager, then call set_lineup with each league's set_lineup arguments (dry_run=true previews).";
  if (ctx.auth) return "The server is read-only: make these changes in the Sleeper app, or restart without --read-only to use set_lineup.";
  return "Make these changes in the Sleeper app, or configure a Sleeper session (SLEEPER_TOKEN) so set_lineup can apply them.";
}
