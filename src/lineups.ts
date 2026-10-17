import { ToolError, type LeagueBundle, type ServerContext } from "./context.js";
import { startingSlots } from "./format.js";
import { hasKickedOff, loadWeekGames, nflTeam, type WeekGames } from "./games.js";
import type { GqlMatchupLeg } from "./sleeper/graphql.js";
import type { Roster } from "./sleeper/types.js";

function startersFor(bundle: LeagueBundle, value: unknown): string[] {
  const count = startingSlots(bundle.league).length;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string") || (value.length !== count && value.length !== 0)) {
    throw new ToolError("Weekly starters are missing or malformed; refresh the lineup in Sleeper before trying again.");
  }
  // Sleeper can represent a completely empty lineup as [].
  return value.length ? [...value] : Array<string>(count).fill("0");
}

/** Read the exact week/roster, rejecting missing or ambiguous records rather than guessing. */
export async function readWeeklyLeg(ctx: ServerContext, bundle: LeagueBundle, rosterId: number, week: number): Promise<GqlMatchupLeg> {
  if (!ctx.auth) throw new ToolError("A Sleeper session is required to read the live weekly lineup.");
  const legs = await ctx.auth.matchupLegs(bundle.league.league_id, week);
  const matches = Array.isArray(legs)
    ? legs.filter((leg) => leg?.league_id === bundle.league.league_id && leg.roster_id === rosterId && leg.round === week && leg.leg === week)
    : [];
  if (matches.length !== 1) {
    throw new ToolError(`Could not identify one weekly lineup for roster ${rosterId}, week ${week}; no roster-default fallback is allowed.`);
  }
  return { ...matches[0]!, starters: startersFor(bundle, matches[0]!.starters) };
}

/** Current in-season reads must describe the scoring lineup, not roster defaults. */
export async function weeklyRoster(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, week: number, requireMatchup = false): Promise<Roster> {
  if (bundle.league.status !== "in_season") return roster;
  if (ctx.auth) {
    const leg = await readWeeklyLeg(ctx, bundle, roster.roster_id, week);
    if (requireMatchup && leg.matchup_id == null) throw new ToolError("This team has no scoring matchup this week; nothing was sent.");
    return { ...roster, starters: leg.starters };
  }
  const matchups = await ctx.client.getMatchups(bundle.league.league_id, week);
  const matches = matchups.filter((m) => m.roster_id === roster.roster_id);
  if (matches.length !== 1) throw new ToolError(`No unambiguous scoring lineup for week ${week}. Roster defaults are not a verified weekly lineup.`);
  return { ...roster, starters: startersFor(bundle, matches[0]!.starters) };
}

/** Resolve a fresh write target and stop at season/week rollover instead of changing another week. */
export async function currentLineupWeek(ctx: ServerContext, bundle: LeagueBundle, expectedWeek?: number): Promise<number> {
  const leagueId = bundle.league.league_id;
  ctx.client.cache.delete("GET /state/nfl");
  ctx.client.cache.delete(`GET /league/${encodeURIComponent(leagueId)}`);
  const [state, league] = await Promise.all([ctx.client.getNflState("nfl"), ctx.client.getLeague(leagueId)]);
  const week = state.week;
  if (league.status !== "in_season" || league.season !== state.season || state.season_type !== "regular" ||
      !Number.isInteger(week) || week < 1 || week > 18 || league.settings?.leg !== week ||
      (expectedWeek !== undefined && week !== expectedWeek)) {
    throw new ToolError("The league and NFL scoring week do not agree, or the week changed. Refresh in Sleeper before retrying; nothing was sent.");
  }
  bundle.league = league;
  return week;
}

export function invalidateWeeklyLineup(ctx: ServerContext, leagueId: string, week: number): void {
  const id = encodeURIComponent(leagueId);
  ctx.client.cache.delete(`GET /league/${id}/rosters`);
  ctx.client.cache.delete(`GET /league/${id}/matchups/${week}`);
}

/** Validate locks before either a dry run or a mutation. Sleeper remains the final authority. */
export async function validateLineupLocks(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, week: number, next: string[]): Promise<void> {
  const state = await ctx.client.getNflState("nfl");
  const games = await loadWeekGames(ctx, bundle.league.season, week, state, true);
  validateLineupLocksFromSnapshot(ctx, bundle, roster, next, games);
}

/** Pure lock validation, shared by real changes and read-only hypothetical comparisons. */
export function validateLineupLocksFromSnapshot(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, next: string[], games: WeekGames): void {
  if (games.source !== "schedule") throw new ToolError("Cannot verify kickoff locks without the NFL schedule; no lineup change was sent.");
  const current = startersFor(bundle, roster.starters);
  const moved = new Set([...current, ...next].filter((id) => id !== "0" && current.indexOf(id) !== next.indexOf(id)));
  for (const id of moved) {
    if (hasKickedOff(games.game(nflTeam(ctx, id)))) {
      throw new ToolError(`${ctx.players.label(id)} is locked because his game has started; no lineup change was sent.`);
    }
  }
}

/** Fresh preflight plus independent read-back; a mutation's response alone is not proof of success. */
export async function saveWeeklyStarters(
  ctx: ServerContext, bundle: LeagueBundle, roster: Roster, week: number, next: string[],
): Promise<{ starters: string[] }> {
  const auth = ctx.auth!;
  await currentLineupWeek(ctx, bundle, week);
  const before = await readWeeklyLeg(ctx, bundle, roster.roster_id, week);
  if (before.matchup_id === null || before.matchup_id === undefined) throw new ToolError("This team has no scoring matchup this week; nothing was sent.");
  if (JSON.stringify(before.starters) !== JSON.stringify(roster.starters)) {
    throw new ToolError("The weekly lineup changed while this move was being prepared. Refresh and preview again; nothing was sent.");
  }
  await validateLineupLocks(ctx, bundle, roster, week, next);
  try {
    try {
      await auth.updateMatchupStarters(bundle.league.league_id, roster.roster_id, before.round, before.leg, next);
    } catch (err) {
      throw new ToolError(`Lineup update not verified: Sleeper did not confirm the request (${(err as Error).message}). It may have applied; check Sleeper before retrying.`);
    }
    let after: GqlMatchupLeg;
    try {
      after = await readWeeklyLeg(ctx, bundle, roster.roster_id, week);
    } catch (err) {
      throw new ToolError(`Lineup update not verified: the request was sent but read-back failed (${(err as Error).message}). Check Sleeper before retrying.`);
    }
    if (JSON.stringify(after.starters) !== JSON.stringify(next)) {
      throw new ToolError("Lineup update not verified: the request was sent, but the weekly starters do not match. Check Sleeper before retrying.");
    }
    return { starters: after.starters! };
  } finally {
    // Even an ambiguous request may have changed upstream state.
    invalidateWeeklyLineup(ctx, bundle.league.league_id, week);
  }
}
