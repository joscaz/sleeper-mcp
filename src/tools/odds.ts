import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasTeamSelector, loadLeague, resolveRoster, resolveWeek, ToolError, type LeagueBundle, type ServerContext, type TeamSelector } from "../context.js";
import { TTL } from "../sleeper/client.js";
import { isTeamDefense } from "../sleeper/players.js";
import type { Matchup, NflState, Roster, ScheduleGame, StatMap } from "../sleeper/types.js";
import { num, points, record, round, scoreStatLine, startingSlots, teamLabel } from "../format.js";
import {
  firstRoundByes,
  hashSeed,
  simulateSeason,
  spreadFor,
  teamOutlook,
  winProbability,
  type ScoreDistribution,
  type SimTeam,
  type SimWeek,
  type StarterOutlook,
  type TeamOutlook,
} from "../odds.js";
import { standings } from "./leagues.js";
import { optimalStarters } from "./stats.js";
import { guard, leagueIdSchema, teamSelectorShape, weekSchema } from "./shared.js";

/** Offensive snaps one team runs in a typical NFL game; used to estimate how far along a live game is. */
const TYPICAL_TEAM_SNAPS = 64;

/** Injury designations that mean a player will not play: their projection counts as 0 before kickoff. */
const RULED_OUT = /^(out|ir|pup|sus|nfi)\b/i;

const MATCHUP_METHOD =
  "Points so far plus each starter's league-scored projection for the share of their game still to play (game status from Sleeper's NFL schedule, live progress from team offensive snaps). Remaining points vary by position; win % is the normal approximation of the score difference.";

export type GameState = "final" | "playing" | "yet_to_play" | "bye" | "no_game";

export interface TeamGame {
  state: GameState;
  /** Share of the game still to play (0..1). */
  remaining: number;
}

export interface WeekGames {
  /** Game state for an NFL team code (null for players without a team). */
  game: (team: string | null) => TeamGame;
  /** Where the game states came from. */
  source: "schedule" | "past_week" | "future_week" | "box_scores";
}

const FINAL: TeamGame = { state: "final", remaining: 0 };
const UPCOMING: TeamGame = { state: "yet_to_play", remaining: 1 };
const BYE: TeamGame = { state: "bye", remaining: 0 };
const NO_GAME: TeamGame = { state: "no_game", remaining: 0 };

export function registerOddsTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_matchup_odds",
    {
      title: "Matchup win probability (live)",
      description:
        "Win probability for a week's matchups (default: current week), updated live during games: points so far plus league-scored projections for the share of each starter's game still to play, using Sleeper's NFL schedule to tell final, live and upcoming games apart. Returns each side's points, projected final and win %, and for a selected team a starter-by-starter view (final / playing / yet to play / bye). Past weeks return results; future weeks are projections only.",
      inputSchema: {
        league_id: leagueIdSchema,
        week: weekSchema,
        ...teamSelectorShape,
        include_players: z
          .boolean()
          .optional()
          .describe("Starter-by-starter breakdown. Default: on when a team is selected, off for the whole league."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, week, include_players, ...selector }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const { week: resolvedWeek, state } = await resolveWeek(ctx, week);
        const season = bundle.league.season;
        const over = weekIsOver(season, resolvedWeek, state);
        const [matchups, projections] = await Promise.all([
          ctx.client.getMatchups(bundle.league.league_id, resolvedWeek),
          over ? Promise.resolve<StatMap>({}) : ctx.client.getProjections("nfl", "regular", season, resolvedWeek),
          ctx.players.ensureLoaded(),
        ]);
        if (!matchups.length) {
          throw new ToolError(`No matchups for week ${resolvedWeek} in league "${bundle.league.name}" (league status: ${bundle.league.status}).`);
        }
        const games = await loadWeekGames(ctx, season, resolvedWeek, state);
        const only = hasTeamSelector(selector) ? (await resolveRoster(ctx, bundle, selector)).roster_id : undefined;
        return describeMatchupOdds(ctx, bundle, matchups, projections, games, resolvedWeek, {
          onlyRosterId: only,
          includePlayers: include_players ?? only !== undefined,
          weekOver: over,
        });
      }),
  );

  server.registerTool(
    "get_playoff_odds",
    {
      title: "Playoff odds (season simulation)",
      description:
        "Playoff odds from simulating the rest of the regular season (10,000 runs by default) over the league's real schedule: every week each team starts its best projected lineup under the league's exact scoring (byes included), the week in progress uses live points, and the league's playoff format (playoff teams, first-round byes, median games) decides seeds. Returns playoff %, bye %, #1-seed %, projected record and average seed for every team; for a selected team (or the default user), also this week's swing (playoff % if they win vs lose) and playoff % by final win total.",
      inputSchema: {
        league_id: leagueIdSchema,
        ...teamSelectorShape,
        simulations: z.number().int().min(1000).max(50000).default(10000).describe("Number of simulated seasons (default 10,000)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, simulations, ...selector }) => guard(() => playoffOdds(ctx, league_id, simulations, selector)),
  );
}

// ---------------------------------------------------------------------------
// Game states: which NFL games are final, live or still to come
// ---------------------------------------------------------------------------

/** The whole week has been played: an earlier season, or an earlier week of the current season. */
export function weekIsOver(season: string, week: number, state: NflState): boolean {
  if (Number(season) < Number(state.season)) return true;
  if (season !== state.season) return false;
  if (state.season_type === "post") return true;
  return state.season_type === "regular" && week < state.week;
}

export async function loadWeekGames(ctx: ServerContext, season: string, week: number, state: NflState): Promise<WeekGames> {
  if (weekIsOver(season, week, state)) return { game: () => FINAL, source: "past_week" };

  let schedule: ScheduleGame[] = [];
  try {
    schedule = await ctx.client.getSchedule("nfl", "regular", season);
  } catch (err) {
    ctx.log(`NFL schedule unavailable (${(err as Error).message}); falling back to box scores`);
  }
  const games = schedule.filter((g) => Number(g.week) === week);
  if (games.length) {
    const byTeam = new Map<string, GameState>();
    for (const g of games) {
      const st = gameState(g.status);
      for (const team of [g.home, g.away]) {
        if (!team) continue;
        const prev = byTeam.get(team);
        if (prev === undefined || prev === "no_game") byTeam.set(team, st); // a canceled listing never hides a real game
      }
    }
    const progress = [...byTeam.values()].includes("playing") ? await liveProgress(ctx, season, week) : new Map<string, number>();
    return {
      source: "schedule",
      game: (team) => {
        if (!team) return NO_GAME;
        const st = byTeam.get(team);
        if (st === undefined) return BYE;
        if (st === "playing") {
          // A game Sleeper still lists as live has a little left; unknown progress counts as halfway.
          const done = progress.get(team);
          return { state: "playing", remaining: done === undefined ? 0.5 : Math.max(0.03, 1 - done) };
        }
        return st === "final" ? FINAL : st === "no_game" ? NO_GAME : UPCOMING;
      },
    };
  }

  // No schedule for this week: later weeks have not started, and the current week falls back to box scores.
  const isCurrent = season === state.season && state.season_type === "regular" && week === state.week;
  if (!isCurrent) return { game: (team) => (team ? UPCOMING : NO_GAME), source: "future_week" };
  const progress = await liveProgress(ctx, season, week);
  return {
    source: "box_scores",
    game: (team) => {
      if (!team) return NO_GAME;
      const done = progress.get(team);
      if (done === undefined) return UPCOMING;
      return done >= 1 ? FINAL : { state: "playing", remaining: 1 - done };
    },
  };
}

function gameState(status: string | null | undefined): GameState {
  const s = String(status ?? "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "final" || s === "closed") return "final";
  if (s === "" || s === "pre_game" || s === "pregame" || s === "scheduled" || s.includes("postpon")) return "yet_to_play";
  if (s.includes("cancel")) return "no_game";
  return "playing"; // in_game, halftime or any other live state
}

/** Share of each NFL team's game already played, from its offensive snaps in the week's box scores. */
async function liveProgress(ctx: ServerContext, season: string, week: number): Promise<Map<string, number>> {
  let stats: StatMap = {};
  try {
    stats = await ctx.client.getStats("nfl", "regular", season, week, { ttlMs: TTL.liveStats });
  } catch (err) {
    ctx.log(`box scores unavailable (${(err as Error).message})`);
  }
  const snaps = new Map<string, number>();
  for (const [id, line] of Object.entries(stats)) {
    const s = num(line?.tm_off_snp);
    if (!s) continue;
    const team = ctx.players.raw(id)?.team ?? (isTeamDefense(id) ? id : null);
    if (team && s > (snaps.get(team) ?? 0)) snaps.set(team, s);
  }
  return new Map([...snaps].map(([team, s]) => [team, Math.min(1, s / TYPICAL_TEAM_SNAPS)]));
}

// ---------------------------------------------------------------------------
// One week's matchups
// ---------------------------------------------------------------------------

export interface StarterView extends StarterOutlook {
  id: string;
  slot: string;
  state: GameState | "empty";
}

export function starterViews(ctx: ServerContext, bundle: LeagueBundle, matchup: Matchup, projections: StatMap, games: WeekGames): StarterView[] {
  const slots = startingSlots(bundle.league);
  const scoring = bundle.league.scoring_settings;
  const scored = matchup.players_points ?? {};
  return (matchup.starters ?? []).map((id, i): StarterView => {
    const slot = slots[i] ?? "FLEX";
    if (!id || id === "0") return { id: "0", slot, state: "empty", points: 0, projection: 0, remaining: 0, pos: null };
    const player = ctx.players.raw(id);
    const game = games.game(player?.team ?? (isTeamDefense(id) ? id : null));
    const ruledOut = game.state === "yet_to_play" && RULED_OUT.test(player?.injury_status ?? "");
    return {
      id,
      slot,
      state: game.state,
      points: num(scored[id]),
      projection: ruledOut ? 0 : scoreStatLine(projections[id] ?? null, scoring),
      remaining: game.remaining,
      pos: ctx.players.ref(id).pos,
    };
  });
}

/** Final-score distribution for one side. A commissioner's custom_points override is final. */
export function sideOutlook(matchup: Matchup, starters: readonly StarterView[]): TeamOutlook {
  if (typeof matchup.custom_points === "number") {
    return { points: matchup.custom_points, still_to_come: 0, mean: matchup.custom_points, variance: 0 };
  }
  const outlook = teamOutlook(starters);
  const onBoard = typeof matchup.points === "number" ? matchup.points : outlook.points;
  return { ...outlook, points: onBoard, mean: onBoard + outlook.still_to_come };
}

type MatchupStatus = "final" | "in_progress" | "upcoming" | "no_lineups";

function matchupStatus(starters: readonly StarterView[]): MatchupStatus {
  let final = 0;
  let live = 0;
  let upcoming = 0;
  for (const s of starters) {
    if (s.state === "final") final++;
    else if (s.state === "playing") live++;
    else if (s.state === "yet_to_play") upcoming++;
  }
  if (live || (final && upcoming)) return "in_progress";
  if (upcoming) return "upcoming";
  return final ? "final" : "no_lineups";
}

function describeMatchupOdds(
  ctx: ServerContext,
  bundle: LeagueBundle,
  matchups: Matchup[],
  projections: StatMap,
  games: WeekGames,
  week: number,
  options: { onlyRosterId?: number; includePlayers: boolean; weekOver: boolean },
) {
  const groups = new Map<number, Matchup[]>();
  const byes: Matchup[] = [];
  for (const m of matchups) {
    if (m.matchup_id === null || m.matchup_id === undefined) byes.push(m);
    else groups.set(m.matchup_id, [...(groups.get(m.matchup_id) ?? []), m]);
  }

  const analyze = (m: Matchup) => {
    const starters = starterViews(ctx, bundle, m, projections, games);
    return { m, starters, outlook: sideOutlook(m, starters) };
  };
  type Side = ReturnType<typeof analyze>;

  const describeSide = (s: Side, win: number | null) => {
    const out: Record<string, unknown> = {
      roster_id: s.m.roster_id,
      team_name: teamNameOf(bundle, s.m.roster_id),
      manager: bundle.teams.get(s.m.roster_id)?.manager ?? null,
      points: round(s.outlook.points, 2),
      projected: round(s.outlook.mean, 1),
    };
    if (win !== null) out.win_pct = round(win * 100, 1);
    out.starters_left = s.starters.filter((p) => p.state === "playing" || p.state === "yet_to_play").length;
    if (options.includePlayers) {
      out.starters = s.starters.map((p) =>
        p.id === "0"
          ? { id: "0", name: "(empty)", pos: null, team: null, slot: p.slot, status: "empty" }
          : { ...ctx.players.ref(p.id), slot: p.slot, status: p.state, pts: round(p.points, 2), proj_left: round(p.projection * p.remaining, 1) },
      );
    }
    return out;
  };

  let pairs = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  if (options.onlyRosterId !== undefined) pairs = pairs.filter(([, ms]) => ms.some((m) => m.roster_id === options.onlyRosterId));

  const described = pairs.map(([matchupId, ms]) => {
    const sides = ms.map(analyze);
    const status: MatchupStatus = options.weekOver ? "final" : matchupStatus(sides.flatMap((s) => s.starters));
    if (sides.length !== 2) return { matchup_id: matchupId, status, teams: sides.map((s) => describeSide(s, null)) };
    // The selected team always comes first.
    const [a, b] = sides[1]!.m.roster_id === options.onlyRosterId ? [sides[1]!, sides[0]!] : [sides[0]!, sides[1]!];
    const pa = winProbability(a.outlook, b.outlook);
    const out: Record<string, unknown> = { matchup_id: matchupId, status, teams: [describeSide(a, pa), describeSide(b, 1 - pa)] };
    const leader = pa === 0.5 ? null : teamNameOf(bundle, (pa > 0.5 ? a : b).m.roster_id);
    if (status === "final") out.winner = leader ?? "tie";
    else out.favorite = leader;
    out.projected_margin = round(Math.abs(a.outlook.mean - b.outlook.mean), 1);
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
  if (relevantByes.length) result.byes = relevantByes.map((m) => describeSide(analyze(m), null));
  if (options.onlyRosterId !== undefined && !described.length && !relevantByes.length) {
    result.note = `Roster ${options.onlyRosterId} has no matchup in week ${week}.`;
  }
  result.game_status_source = games.source;
  result.method = MATCHUP_METHOD;
  return result;
}

// ---------------------------------------------------------------------------
// Rest-of-season simulation
// ---------------------------------------------------------------------------

async function playoffOdds(ctx: ServerContext, leagueId: string, simulations: number, selector: TeamSelector) {
  const bundle = await loadLeague(ctx, leagueId);
  const { league } = bundle;
  const settings = league.settings ?? {};
  const playoffTeams = num(settings.playoff_teams);
  const playoffStart = num(settings.playoff_week_start);
  if (!playoffTeams || !playoffStart) {
    throw new ToolError(`League "${league.name}" has no playoff format (playoff_teams / playoff_week_start), so there is nothing to simulate.`);
  }
  if (league.status === "pre_draft" || league.status === "drafting") {
    throw new ToolError(`League "${league.name}" has not finished its draft (status: ${league.status}); playoff odds need rosters and a schedule.`);
  }

  const state = await ctx.client.getNflState("nfl");
  const lastScored = num(settings.last_scored_leg);
  const firstWeek = Math.max(num(settings.start_week) || 1, lastScored + 1);
  const lastWeek = playoffStart - 1;
  const base = { league_id: league.league_id, league: league.name, season: league.season, playoff_teams: playoffTeams };

  if (league.status === "complete" || firstWeek > lastWeek || Number(league.season) < Number(state.season)) {
    const table = standings(league, bundle.rosters, bundle.teams).standings;
    return {
      ...base,
      status: "regular_season_over",
      note: `The regular season is over (playoffs start in week ${playoffStart}), so there is nothing left to simulate. Seeds follow the final standings; use get_playoff_bracket for the playoffs themselves.`,
      seeds: table.slice(0, playoffTeams).map((r) => ({ seed: r.rank, team_name: r.team_name, manager: r.manager, record: r.record, points_for: r.points_for })),
    };
  }

  let focusRosterId: number | undefined;
  if (hasTeamSelector(selector)) focusRosterId = (await resolveRoster(ctx, bundle, selector)).roster_id;
  else if (ctx.defaultUser) focusRosterId = await resolveRoster(ctx, bundle, {}).then((r) => r.roster_id, () => undefined);

  await ctx.players.ensureLoaded();
  const currentWeek = league.season === state.season && state.season_type === "regular" ? state.week : 0;
  const loaded = await mapLimit(range(firstWeek, lastWeek), 4, async (week) => {
    const live = week <= currentWeek;
    const over = live && weekIsOver(league.season, week, state);
    const [matchups, projections, games] = await Promise.all([
      ctx.client.getMatchups(league.league_id, week),
      over ? Promise.resolve<StatMap>({}) : ctx.client.getProjections("nfl", "regular", league.season, week),
      live ? loadWeekGames(ctx, league.season, week, state) : Promise.resolve(null),
    ]);
    return { week, matchups, projections, games };
  });

  // Weeks that have not started: every team's best projected lineup. A week Sleeper has no projections
  // for yet borrows the nearest week that has them.
  const projected = loaded.map((w) =>
    w.games || !Object.keys(w.projections).length ? null : new Map(bundle.rosters.map((r) => [r.roster_id, projectedWeek(ctx, bundle, r, w.projections)])),
  );
  const withProjections = projected.flatMap((p, i) => (p ? [i] : []));
  const missingProjections: number[] = [];
  const unknownSchedule: number[] = [];
  const opponents = new Map<number, { sum: number; n: number }>();

  const weeks: SimWeek[] = loaded.map((w, i) => {
    let scores: Map<number, ScoreDistribution>;
    const games = w.games;
    if (games) {
      scores = new Map(w.matchups.map((m) => [m.roster_id, sideOutlook(m, starterViews(ctx, bundle, m, w.projections, games))]));
    } else {
      let p = projected[i];
      if (!p) {
        const nearest = nearestIndex(withProjections, i);
        if (nearest === undefined) {
          throw new ToolError(`Sleeper has no projections for weeks ${firstWeek}-${lastWeek} yet, so the season cannot be simulated.`);
        }
        missingProjections.push(w.week);
        p = projected[nearest]!;
      }
      scores = p;
    }
    const pairs = pairsFrom(w.matchups);
    if (!pairs) unknownSchedule.push(w.week);
    for (const [a, b] of pairs ?? []) {
      addOpponent(opponents, a, scores.get(b)?.mean);
      addOpponent(opponents, b, scores.get(a)?.mean);
    }
    return { week: w.week, pairs, scores, projected: !games };
  });

  const teams: SimTeam[] = bundle.rosters.map((r) => ({
    roster_id: r.roster_id,
    wins: num(r.settings?.wins),
    losses: num(r.settings?.losses),
    ties: num(r.settings?.ties),
    points_for: points(r.settings, "fpts"),
  }));
  const byes = firstRoundByes(playoffTeams);
  const medianGame = num(settings.league_average_match) === 1;
  const sim = simulateSeason(teams, weeks, {
    simulations,
    seed: hashSeed(`${league.league_id}:${lastScored}:${currentWeek}`),
    playoffTeams,
    byes,
    medianGame,
    focusRosterId,
  });

  const pct = (p: number) => round(p * 100, 1);
  const rows = sim.teams
    .map((t) => {
      const roster = bundle.rosters.find((r) => r.roster_id === t.roster_id);
      const opp = opponents.get(t.roster_id);
      const row: Record<string, unknown> = {
        roster_id: t.roster_id,
        team_name: teamNameOf(bundle, t.roster_id),
        manager: bundle.teams.get(t.roster_id)?.manager ?? null,
        record: record(roster?.settings),
        points_for: points(roster?.settings, "fpts"),
        projected_record: formatRecord(t.avg_wins, t.avg_losses, t.avg_ties),
        playoff_pct: pct(t.playoffs),
      };
      if (byes) row.bye_pct = pct(t.bye);
      row.top_seed_pct = pct(t.top_seed);
      row.avg_seed = round(t.avg_seed, 1);
      row.remaining_opponents_avg = opp?.n ? round(opp.sum / opp.n, 1) : null;
      return { row, playoffs: t.playoffs, seed: t.avg_seed };
    })
    .sort((a, b) => b.playoffs - a.playoffs || a.seed - b.seed)
    .map((r) => r.row);

  const f = sim.focus;
  const focus = f && {
    roster_id: f.roster_id,
    team_name: teamNameOf(bundle, f.roster_id),
    playoff_pct: pct(f.playoffs),
    this_week: f.first_week && {
      week: f.first_week.week,
      opponent: f.first_week.opponent === null ? null : teamLabel(bundle.teams, f.first_week.opponent),
      win_pct: pct(f.first_week.win),
      playoff_pct_if_win: f.first_week.playoffs_if_win === null ? null : pct(f.first_week.playoffs_if_win),
      playoff_pct_if_loss: f.first_week.playoffs_if_loss === null ? null : pct(f.first_week.playoffs_if_loss),
    },
    by_final_wins: f.by_final_wins.filter((e) => e.share >= 0.005).map((e) => ({ wins: e.wins, chance_pct: pct(e.share), playoff_pct: pct(e.playoffs) })),
  };

  const notes: string[] = [];
  if (num(settings.divisions) > 0) notes.push("This league has divisions: seeds here go by record, then points for, without division-winner berths.");
  if (unknownSchedule.length) notes.push(`Sleeper has no matchups scheduled for week(s) ${unknownSchedule.join(", ")}; opponents were drawn at random.`);
  if (missingProjections.length) notes.push(`No projections yet for week(s) ${missingProjections.join(", ")}; the nearest week's projections stand in.`);

  return {
    ...base,
    weeks_simulated: firstWeek === lastWeek ? String(firstWeek) : `${firstWeek}-${lastWeek}`,
    simulations: sim.simulations,
    ...(byes ? { first_round_byes: byes } : {}),
    ...(medianGame ? { median_game: true } : {}),
    teams: rows,
    ...(focus ? { focus } : {}),
    ...(notes.length ? { notes } : {}),
    method: `Simulated the rest of the regular season ${sim.simulations.toLocaleString("en-US")} times over the league's schedule. Each week every team starts its best projected lineup under the league's scoring (the week in progress uses live points plus projections for the time left), scores vary by position, and each team carries a season-long projection error. Seeds go by record, then points for. 100% or 0% means every simulation, not a mathematical clinch or elimination.`,
  };
}

/** Projected score distribution for a roster's best lineup (IR and taxi players cannot start). */
function projectedWeek(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, projections: StatMap): ScoreDistribution {
  const scoring = bundle.league.scoring_settings;
  const unavailable = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])]);
  const candidates = (roster.players ?? []).filter((id) => !unavailable.has(id));
  const projected = new Map(candidates.map((id) => [id, scoreStatLine(projections[id] ?? null, scoring)]));
  let mean = 0;
  let variance = 0;
  for (const id of optimalStarters(ctx, bundle.league, candidates, projected)) {
    const mu = id ? (projected.get(id) ?? 0) : 0;
    if (!id || mu <= 0) continue;
    const sd = spreadFor(ctx.players.ref(id).pos) * mu;
    mean += mu;
    variance += sd * sd;
  }
  return { mean, variance };
}

function pairsFrom(matchups: readonly Matchup[]): [number, number][] | null {
  const groups = new Map<number, number[]>();
  for (const m of matchups) {
    if (m.matchup_id === null || m.matchup_id === undefined) continue;
    groups.set(m.matchup_id, [...(groups.get(m.matchup_id) ?? []), m.roster_id]);
  }
  if (!groups.size) return null;
  const pairs: [number, number][] = [];
  for (const ids of groups.values()) if (ids.length === 2) pairs.push([ids[0]!, ids[1]!]);
  return pairs;
}

function addOpponent(map: Map<number, { sum: number; n: number }>, rosterId: number, opponentMean: number | undefined): void {
  if (opponentMean === undefined) return;
  const entry = map.get(rosterId) ?? { sum: 0, n: 0 };
  entry.sum += opponentMean;
  entry.n++;
  map.set(rosterId, entry);
}

function nearestIndex(candidates: readonly number[], target: number): number | undefined {
  let best: number | undefined;
  for (const c of candidates) {
    if (best === undefined || Math.abs(c - target) < Math.abs(best - target)) best = c;
  }
  return best;
}

function formatRecord(wins: number, losses: number, ties: number): string {
  const w = round(wins, 1);
  const l = round(losses, 1);
  return ties >= 0.05 ? `${w}-${l}-${round(ties, 1)}` : `${w}-${l}`;
}

function teamNameOf(bundle: LeagueBundle, rosterId: number): string {
  return bundle.teams.get(rosterId)?.team_name ?? `Roster ${rosterId}`;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
