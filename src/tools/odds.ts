import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hasTeamSelector, loadLeague, resolveRoster, resolveWeek, ToolError, type LeagueBundle, type ServerContext, type TeamSelector } from "../context.js";
import { isTeamDefense, normalizeName } from "../sleeper/players.js";
import type { Matchup, NflState, Roster, StatMap } from "../sleeper/types.js";
import { num, points, record, round, scoreStatLine, startingSlots, teamLabel } from "../format.js";
import { loadWeekGames, weekIsOver, type GameState, type WeekGames } from "../games.js";
import {
  firstRoundByes,
  hashSeed,
  simulateSeason,
  spreadFor,
  teamOutlook,
  winProbability,
  type ScoreDistribution,
  type SimOptions,
  type SimResult,
  type SimTeam,
  type SimWeek,
  type StarterOutlook,
  type TeamOutlook,
} from "../odds.js";
import { findOnRoster, resolveAnyPlayer } from "./account.js";
import { standings } from "./leagues.js";
import { optimalStarters } from "./stats.js";
import { guard, leagueIdSchema, teamSelectorShape, weekSchema } from "./shared.js";

/** Injury designations that mean a player will not play: their projection counts as 0 before kickoff. */
const RULED_OUT = /^(out|ir|pup|sus|nfi)\b/i;

const MATCHUP_METHOD =
  "Points so far plus each starter's league-scored projection for the share of their game still to play (game status from Sleeper's NFL schedule, live progress from team offensive snaps). Remaining points vary by position; win % is the normal approximation of the score difference.";

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

  server.registerTool(
    "get_move_impact",
    {
      title: "What-if: trade or add/drop impact on playoff odds",
      description:
        "What a trade, waiver claim or add/drop would do to playoff odds, for your team and the trade partner. Simulates the rest of the regular season twice with the same random draws (current rosters vs rosters after the move, which counts from the next week that has not started), so the gap reflects the move, not chance. Returns before/after playoff %, bye %, #1-seed %, projected record and average weekly projection, plus who enters and leaves the best lineup. Draft picks and FAAB don't change this season's simulation, so leave them out.",
      inputSchema: {
        league_id: leagueIdSchema,
        ...teamSelectorShape,
        give: playerList("Players your team sends away in a trade (names or player_ids)."),
        receive: playerList("Players your team gets in a trade. They must all be on one team, which becomes the trade partner."),
        partner: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Trade partner (username, team name or roster_id). Only needed when you receive nobody, e.g. a player for draft picks."),
        add: playerList("Free agents to pick up (waiver claim or free-agent add)."),
        drop: playerList("Players to release."),
        simulations: z.number().int().min(1000).max(50000).default(10000).describe("Number of simulated seasons (default 10,000)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, give, receive, partner, add, drop, simulations, ...selector }) =>
      guard(() => moveImpact(ctx, league_id, { give: give ?? [], receive: receive ?? [], partner, add: add ?? [], drop: drop ?? [] }, simulations, selector)),
  );
}

function playerList(description: string) {
  return z.array(z.string().trim().min(1)).max(10).optional().describe(description);
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

interface PlayoffFormat {
  playoffTeams: number;
  playoffStart: number;
}

/** The league's playoff format. Errors when there is nothing to simulate (no playoffs, or no rosters yet). */
function playoffFormat(bundle: LeagueBundle): PlayoffFormat {
  const { league } = bundle;
  const playoffTeams = num(league.settings?.playoff_teams);
  const playoffStart = num(league.settings?.playoff_week_start);
  if (!playoffTeams || !playoffStart) {
    throw new ToolError(`League "${league.name}" has no playoff format (playoff_teams / playoff_week_start), so there is nothing to simulate.`);
  }
  if (league.status === "pre_draft" || league.status === "drafting") {
    throw new ToolError(`League "${league.name}" has not finished its draft (status: ${league.status}); playoff odds need rosters and a schedule.`);
  }
  return { playoffTeams, playoffStart };
}

interface SeasonWindow {
  lastScored: number;
  firstWeek: number;
  lastWeek: number;
  /** The NFL week in progress for this league's season (0 outside the regular season). */
  currentWeek: number;
  /** The regular season is over: nothing left to simulate. */
  over: boolean;
}

function seasonWindow(bundle: LeagueBundle, format: PlayoffFormat, state: NflState): SeasonWindow {
  const { league } = bundle;
  const lastScored = num(league.settings?.last_scored_leg);
  const firstWeek = Math.max(num(league.settings?.start_week) || 1, lastScored + 1);
  const lastWeek = format.playoffStart - 1;
  const currentWeek = league.season === state.season && state.season_type === "regular" ? state.week : 0;
  const over = league.status === "complete" || firstWeek > lastWeek || Number(league.season) < Number(state.season);
  return { lastScored, firstWeek, lastWeek, currentWeek, over };
}

interface LoadedWeek {
  week: number;
  matchups: Matchup[];
  projections: StatMap;
  /** Game states for weeks already under way; null for weeks that have not started. */
  games: WeekGames | null;
}

interface SeasonPlan extends PlayoffFormat, SeasonWindow {
  bundle: LeagueBundle;
  weeks: LoadedWeek[];
}

/** Matchups, projections and (for weeks under way) game states for every remaining regular-season week. */
async function loadSeasonPlan(ctx: ServerContext, bundle: LeagueBundle, format: PlayoffFormat, window: SeasonWindow, state: NflState): Promise<SeasonPlan> {
  const { league } = bundle;
  await ctx.players.ensureLoaded();
  const weeks = await mapLimit(range(window.firstWeek, window.lastWeek), 4, async (week): Promise<LoadedWeek> => {
    const live = week <= window.currentWeek;
    const over = live && weekIsOver(league.season, week, state);
    const [matchups, projections, games] = await Promise.all([
      ctx.client.getMatchups(league.league_id, week),
      over ? Promise.resolve<StatMap>({}) : ctx.client.getProjections("nfl", "regular", league.season, week),
      live ? loadWeekGames(ctx, league.season, week, state) : Promise.resolve(null),
    ]);
    return { week, matchups, projections, games };
  });
  return { bundle, ...format, ...window, weeks };
}

interface SimInputs {
  weeks: SimWeek[];
  missingProjections: number[];
  unknownSchedule: number[];
  opponents: Map<number, { sum: number; n: number }>;
}

/**
 * Simulation weeks for a season plan. Weeks under way start from live points; weeks that have not started use
 * every team's best projected lineup, built from `players` where given (a what-if) and the current rosters
 * otherwise. A week Sleeper has no projections for yet borrows the nearest week that has them.
 */
function buildSimWeeks(ctx: ServerContext, plan: SeasonPlan, players?: ReadonlyMap<number, readonly string[]>): SimInputs {
  const { bundle } = plan;
  const projected = plan.weeks.map((w) =>
    w.games || !Object.keys(w.projections).length
      ? null
      : new Map(bundle.rosters.map((r) => [r.roster_id, projectedWeek(ctx, bundle, r, w.projections, players?.get(r.roster_id))])),
  );
  const withProjections = projected.flatMap((p, i) => (p ? [i] : []));
  const missingProjections: number[] = [];
  const unknownSchedule: number[] = [];
  const opponents = new Map<number, { sum: number; n: number }>();

  const weeks: SimWeek[] = plan.weeks.map((w, i) => {
    let scores: Map<number, ScoreDistribution>;
    const games = w.games;
    if (games) {
      scores = new Map(w.matchups.map((m) => [m.roster_id, sideOutlook(m, starterViews(ctx, bundle, m, w.projections, games))]));
    } else {
      let p = projected[i];
      if (!p) {
        const nearest = nearestIndex(withProjections, i);
        if (nearest === undefined) {
          throw new ToolError(`Sleeper has no projections for weeks ${plan.firstWeek}-${plan.lastWeek} yet, so the season cannot be simulated.`);
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
  return { weeks, missingProjections, unknownSchedule, opponents };
}

function simTeams(bundle: LeagueBundle): SimTeam[] {
  return bundle.rosters.map((r) => ({
    roster_id: r.roster_id,
    wins: num(r.settings?.wins),
    losses: num(r.settings?.losses),
    ties: num(r.settings?.ties),
    points_for: points(r.settings, "fpts"),
  }));
}

/** The seed depends only on the league and week, so repeated calls and before/after what-ifs share their random draws. */
function simOptions(plan: SeasonPlan, simulations: number, focusRosterId?: number): SimOptions {
  return {
    simulations,
    seed: hashSeed(`${plan.bundle.league.league_id}:${plan.lastScored}:${plan.currentWeek}`),
    playoffTeams: plan.playoffTeams,
    byes: firstRoundByes(plan.playoffTeams),
    medianGame: num(plan.bundle.league.settings?.league_average_match) === 1,
    focusRosterId,
  };
}

function simulationNotes(bundle: LeagueBundle, inputs: SimInputs): string[] {
  const notes: string[] = [];
  if (num(bundle.league.settings?.divisions) > 0) notes.push("This league has divisions: seeds here go by record, then points for, without division-winner berths.");
  if (inputs.unknownSchedule.length) notes.push(`Sleeper has no matchups scheduled for week(s) ${inputs.unknownSchedule.join(", ")}; opponents were drawn at random.`);
  if (inputs.missingProjections.length) notes.push(`No projections yet for week(s) ${inputs.missingProjections.join(", ")}; the nearest week's projections stand in.`);
  return notes;
}

function weeksLabel(plan: SeasonPlan): string {
  return plan.firstWeek === plan.lastWeek ? String(plan.firstWeek) : `${plan.firstWeek}-${plan.lastWeek}`;
}

async function playoffOdds(ctx: ServerContext, leagueId: string, simulations: number, selector: TeamSelector) {
  const bundle = await loadLeague(ctx, leagueId);
  const { league } = bundle;
  const format = playoffFormat(bundle);
  const state = await ctx.client.getNflState("nfl");
  const window = seasonWindow(bundle, format, state);
  const base = { league_id: league.league_id, league: league.name, season: league.season, playoff_teams: format.playoffTeams };

  if (window.over) {
    const table = standings(league, bundle.rosters, bundle.teams).standings;
    return {
      ...base,
      status: "regular_season_over",
      note: `The regular season is over (playoffs start in week ${format.playoffStart}), so there is nothing left to simulate. Seeds follow the final standings; use get_playoff_bracket for the playoffs themselves.`,
      seeds: table.slice(0, format.playoffTeams).map((r) => ({ seed: r.rank, team_name: r.team_name, manager: r.manager, record: r.record, points_for: r.points_for })),
    };
  }

  let focusRosterId: number | undefined;
  if (hasTeamSelector(selector)) focusRosterId = (await resolveRoster(ctx, bundle, selector)).roster_id;
  else if (ctx.defaultUser) focusRosterId = await resolveRoster(ctx, bundle, {}).then((r) => r.roster_id, () => undefined);

  const plan = await loadSeasonPlan(ctx, bundle, format, window, state);
  const inputs = buildSimWeeks(ctx, plan);
  const options = simOptions(plan, simulations, focusRosterId);
  const sim = simulateSeason(simTeams(bundle), inputs.weeks, options);

  const pct = (p: number) => round(p * 100, 1);
  const rows = sim.teams
    .map((t) => {
      const roster = bundle.rosters.find((r) => r.roster_id === t.roster_id);
      const opp = inputs.opponents.get(t.roster_id);
      const row: Record<string, unknown> = {
        roster_id: t.roster_id,
        team_name: teamNameOf(bundle, t.roster_id),
        manager: bundle.teams.get(t.roster_id)?.manager ?? null,
        record: record(roster?.settings),
        points_for: points(roster?.settings, "fpts"),
        projected_record: formatRecord(t.avg_wins, t.avg_losses, t.avg_ties),
        playoff_pct: pct(t.playoffs),
      };
      if (options.byes) row.bye_pct = pct(t.bye);
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

  const notes = simulationNotes(bundle, inputs);
  return {
    ...base,
    weeks_simulated: weeksLabel(plan),
    simulations: sim.simulations,
    ...(options.byes ? { first_round_byes: options.byes } : {}),
    ...(options.medianGame ? { median_game: true } : {}),
    teams: rows,
    ...(focus ? { focus } : {}),
    ...(notes.length ? { notes } : {}),
    method: `Simulated the rest of the regular season ${sim.simulations.toLocaleString("en-US")} times over the league's schedule. Each week every team starts its best projected lineup under the league's scoring (the week in progress uses live points plus projections for the time left), scores vary by position, and each team carries a season-long projection error. Seeds go by record, then points for. 100% or 0% means every simulation, not a mathematical clinch or elimination.`,
  };
}

// ---------------------------------------------------------------------------
// What-if: a trade or add/drop, simulated against the same random draws
// ---------------------------------------------------------------------------

interface MoveInput {
  give: string[];
  receive: string[];
  partner?: string;
  add: string[];
  drop: string[];
}

interface ResolvedMove {
  give: string[];
  receive: string[];
  add: string[];
  drop: string[];
  partner: Roster | null;
  /** Player lists after the move, for the rosters it touches. */
  players: Map<number, string[]>;
}

async function moveImpact(ctx: ServerContext, leagueId: string, input: MoveInput, simulations: number, selector: TeamSelector) {
  if (!input.give.length && !input.receive.length && !input.add.length && !input.drop.length) {
    throw new ToolError("Describe the move with at least one of give, receive, add or drop.");
  }
  const bundle = await loadLeague(ctx, leagueId);
  const { league } = bundle;
  const format = playoffFormat(bundle);
  const state = await ctx.client.getNflState("nfl");
  const window = seasonWindow(bundle, format, state);
  if (window.over) {
    throw new ToolError(`The regular season in "${league.name}" is over (playoffs start in week ${format.playoffStart}), so a roster move can no longer change playoff odds.`);
  }

  await ctx.players.ensureLoaded();
  const mine = await resolveRoster(ctx, bundle, selector);
  const move = await resolveMove(ctx, bundle, mine, input);

  const plan = await loadSeasonPlan(ctx, bundle, format, window, state);
  const firstOpen = plan.weeks.findIndex((w) => !w.games);
  if (firstOpen < 0) {
    throw new ToolError(`Week ${plan.lastWeek} is the last regular-season week and it has already started, so a roster move can no longer change playoff odds.`);
  }
  const effectiveWeek = plan.weeks[firstOpen]!.week;

  // Same seed, weeks and pairings: both runs see identical random draws, so the gap between them is the move.
  const before = buildSimWeeks(ctx, plan);
  const after = buildSimWeeks(ctx, plan, move.players);
  const options = simOptions(plan, simulations);
  const teams = simTeams(bundle);
  const simBefore = simulateSeason(teams, before.weeks, options);
  const simAfter = simulateSeason(teams, after.weeks, options);

  const pct = (p: number) => round(p * 100, 1);
  const resultFor = (sim: SimResult, rosterId: number) => sim.teams.find((t) => t.roster_id === rosterId)!;
  const lineupWeek = plan.weeks.slice(firstOpen).find((w) => Object.keys(w.projections).length > 0);

  const impactFor = (roster: Roster) => {
    const b = resultFor(simBefore, roster.roster_id);
    const a = resultFor(simAfter, roster.roster_id);
    const out: Record<string, unknown> = {
      roster_id: roster.roster_id,
      team_name: teamNameOf(bundle, roster.roster_id),
      manager: bundle.teams.get(roster.roster_id)?.manager ?? null,
      playoff_pct_before: pct(b.playoffs),
      playoff_pct_after: pct(a.playoffs),
      playoff_pct_change: pct(a.playoffs - b.playoffs),
    };
    if (options.byes) {
      out.bye_pct_before = pct(b.bye);
      out.bye_pct_after = pct(a.bye);
    }
    out.top_seed_pct_before = pct(b.top_seed);
    out.top_seed_pct_after = pct(a.top_seed);
    out.projected_record_before = formatRecord(b.avg_wins, b.avg_losses, b.avg_ties);
    out.projected_record_after = formatRecord(a.avg_wins, a.avg_losses, a.avg_ties);
    out.weekly_projection_before = round(averageProjection(before, roster.roster_id), 1);
    out.weekly_projection_after = round(averageProjection(after, roster.roster_id), 1);
    if (lineupWeek) out.lineup_change = lineupChange(ctx, bundle, roster, lineupWeek, move.players.get(roster.roster_id));
    return out;
  };

  const touched = new Set(move.players.keys());
  const otherTeams = simAfter.teams
    .filter((t) => !touched.has(t.roster_id))
    .map((a) => ({ a, b: resultFor(simBefore, a.roster_id) }))
    .filter(({ a, b }) => Math.abs(a.playoffs - b.playoffs) >= 0.01)
    .sort((x, y) => Math.abs(y.a.playoffs - y.b.playoffs) - Math.abs(x.a.playoffs - x.b.playoffs))
    .map(({ a, b }) => ({
      team_name: teamNameOf(bundle, a.roster_id),
      playoff_pct_before: pct(b.playoffs),
      playoff_pct_after: pct(a.playoffs),
      playoff_pct_change: pct(a.playoffs - b.playoffs),
    }));

  const notes: string[] = [];
  if (firstOpen > 0) {
    const started = plan.weeks.slice(0, firstOpen).map((w) => w.week);
    const which = started.length === 1 ? `Week ${started[0]} has` : `Weeks ${started[0]}-${started[started.length - 1]} have`;
    notes.push(`${which} already started, so the move counts from week ${effectiveWeek}.`);
  }
  notes.push(...rosterSizeNotes(bundle, mine, move), ...simulationNotes(bundle, before));

  return {
    league_id: league.league_id,
    league: league.name,
    season: league.season,
    team: teamNameOf(bundle, mine.roster_id),
    move: {
      ...(move.partner ? { trade_partner: teamLabel(bundle.teams, move.partner.roster_id) } : {}),
      ...(move.give.length ? { give: ctx.players.refs(move.give) } : {}),
      ...(move.receive.length ? { receive: ctx.players.refs(move.receive) } : {}),
      ...(move.add.length ? { add: ctx.players.refs(move.add) } : {}),
      ...(move.drop.length ? { drop: ctx.players.refs(move.drop) } : {}),
      effective_week: effectiveWeek,
    },
    impact: [impactFor(mine), ...(move.partner ? [impactFor(move.partner)] : [])],
    ...(otherTeams.length ? { other_teams: otherTeams } : {}),
    weeks_simulated: weeksLabel(plan),
    simulations: simAfter.simulations,
    ...(notes.length ? { notes } : {}),
    method: `Ran the rest-of-season simulation twice with the same random draws, once with current rosters and once with the move applied from week ${effectiveWeek}. Every week each team starts its best projected lineup under league scoring, so the gap between the two runs comes from the move rather than chance.`,
  };
}

async function resolveMove(ctx: ServerContext, bundle: LeagueBundle, mine: Roster, input: MoveInput): Promise<ResolvedMove> {
  const myTeam = teamNameOf(bundle, mine.roster_id);
  const others = bundle.rosters.filter((r) => r.roster_id !== mine.roster_id);
  const give = input.give.map((p) => findOnRoster(ctx, mine, p, myTeam));
  const drop = input.drop.map((p) => findOnRoster(ctx, mine, p, myTeam));
  const receive = input.receive.map((p) => findOnOtherTeam(ctx, bundle, mine, others, p));
  const add = input.add.map((p) => findFreeAgent(ctx, bundle, mine, p));

  const all = [...give, ...drop, ...receive, ...add];
  const repeated = all.find((id, i) => all.indexOf(id) !== i);
  if (repeated) throw new ToolError(`${ctx.players.label(repeated)} appears more than once in the move.`);

  const ownerOf = (id: string) => others.find((r) => r.players?.includes(id))!;
  const owners = [...new Set(receive.map((id) => ownerOf(id).roster_id))];
  if (owners.length > 1) {
    throw new ToolError(
      `The players to receive are on different teams (${owners.map((id) => teamLabel(bundle.teams, id)).join("; ")}). Three-team trades are not supported: simulate one partner at a time.`,
    );
  }
  let partner = receive.length ? ownerOf(receive[0]!) : null;
  if (input.partner) {
    if (!give.length && !receive.length) throw new ToolError("partner only applies to trades: list the players you give or receive.");
    const named = await resolveTradePartner(ctx, bundle, input.partner);
    if (named.roster_id === mine.roster_id) throw new ToolError("The trade partner can't be your own team.");
    if (partner && partner.roster_id !== named.roster_id) {
      throw new ToolError(`The players to receive are on ${teamLabel(bundle.teams, partner.roster_id)}, not ${teamLabel(bundle.teams, named.roster_id)}.`);
    }
    partner = named;
  }
  if (give.length && !partner) throw new ToolError("Who gets the players you give? Name the trade partner with partner, or list the players you receive.");

  const leaving = new Set([...give, ...drop]);
  const players = new Map<number, string[]>([[mine.roster_id, [...(mine.players ?? []).filter((id) => !leaving.has(id)), ...receive, ...add]]]);
  if (partner) {
    const incoming = new Set(receive);
    players.set(partner.roster_id, [...(partner.players ?? []).filter((id) => !incoming.has(id)), ...give]);
  }
  return { give, receive, add, drop, partner, players };
}

async function resolveTradePartner(ctx: ServerContext, bundle: LeagueBundle, partner: string): Promise<Roster> {
  const trimmed = partner.trim();
  return /^\d{1,3}$/.test(trimmed) ? resolveRoster(ctx, bundle, { roster_id: Number(trimmed) }) : resolveRoster(ctx, bundle, { team: trimmed });
}

const DEF_SUFFIX = /\s+(def|dst|d\/st|defense)$/i;

/** Players among `ids` matching a name or player_id: exact full names first, then partial or last-name matches. */
function matchPlayers(ctx: ServerContext, ids: readonly string[], input: string): string[] {
  const raw = input.trim();
  if (ids.includes(raw)) return [raw];
  if (ids.includes(raw.toUpperCase())) return [raw.toUpperCase()];
  const q = normalizeName(raw.replace(DEF_SUFFIX, ""));
  if (!q) return [];
  const named = ids.map((id) => ({ id, name: normalizeName(ctx.players.ref(id).name), last: normalizeName(ctx.players.raw(id)?.last_name ?? "") }));
  const exact = named.filter((n) => n.name === q);
  return (exact.length ? exact : named.filter((n) => n.name.includes(q) || n.last === q)).map((n) => n.id);
}

/** A player on another team's roster, by name or player_id. */
function findOnOtherTeam(ctx: ServerContext, bundle: LeagueBundle, mine: Roster, others: readonly Roster[], input: string): string {
  const matches = matchPlayers(ctx, others.flatMap((r) => r.players ?? []), input);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const owner = (id: string) => teamLabel(bundle.teams, others.find((r) => r.players?.includes(id))?.roster_id);
    throw new ToolError(`"${input}" matches several rostered players: ${matches.map((id) => `${ctx.players.label(id)} on ${owner(id)}`).join("; ")}. Use the player_id.`);
  }
  const id = resolveAnyPlayer(ctx, input);
  if (mine.players?.includes(id)) throw new ToolError(`${ctx.players.label(id)} is already on ${teamNameOf(bundle, mine.roster_id)}; list them under give to trade them away.`);
  throw new ToolError(`${ctx.players.label(id)} is a free agent in this league; use add instead of receive.`);
}

/** A free agent, by name or player_id (the same matching add_drop_player uses). */
function findFreeAgent(ctx: ServerContext, bundle: LeagueBundle, mine: Roster, input: string): string {
  const id = resolveAnyPlayer(ctx, input);
  const owner = bundle.rosters.find((r) => r.players?.includes(id));
  if (owner?.roster_id === mine.roster_id) throw new ToolError(`${ctx.players.label(id)} is already on ${teamNameOf(bundle, mine.roster_id)}.`);
  if (owner) throw new ToolError(`${ctx.players.label(id)} is rostered by ${teamLabel(bundle.teams, owner.roster_id)}, so getting them is a trade: list them under receive.`);
  return id;
}

/** A roster's average projected score over the weeks that have not started. */
function averageProjection(inputs: SimInputs, rosterId: number): number {
  const means = inputs.weeks.filter((w) => w.projected).map((w) => w.scores.get(rosterId)?.mean ?? 0);
  return means.length ? means.reduce((sum, m) => sum + m, 0) / means.length : 0;
}

/** Who enters and leaves a roster's best projected lineup in `week` when its players change. */
function lineupChange(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, week: LoadedWeek, playersAfter: readonly string[] | undefined) {
  const slots = startingSlots(bundle.league);
  const before = bestLineup(ctx, bundle, roster, week.projections);
  const after = bestLineup(ctx, bundle, roster, week.projections, playersAfter);
  const ids = (lineup: Lineup) => new Set(lineup.starters.filter((id): id is string => Boolean(id)));
  const was = ids(before);
  const now = ids(after);
  const describe = (lineup: Lineup, id: string) => ({
    ...ctx.players.ref(id),
    slot: slots[lineup.starters.indexOf(id)] ?? "FLEX",
    pts: round(lineup.projected.get(id) ?? 0, 1),
  });
  return {
    week: week.week,
    now_starting: [...now].filter((id) => !was.has(id)).map((id) => describe(after, id)),
    no_longer_starting: [...was].filter((id) => !now.has(id)).map((id) => describe(before, id)),
    projected_before: round(lineupTotal(before), 1),
    projected_after: round(lineupTotal(after), 1),
  };
}

/** Warn when a move leaves a roster with more active players than it has room for. */
function rosterSizeNotes(bundle: LeagueBundle, mine: Roster, move: ResolvedMove): string[] {
  const room = (bundle.league.roster_positions ?? []).filter((slot) => slot !== "IR" && slot !== "TAXI").length;
  if (!room) return [];
  const notes: string[] = [];
  for (const [rosterId, players] of move.players) {
    const roster = bundle.rosters.find((r) => r.roster_id === rosterId);
    const parked = new Set([...(roster?.reserve ?? []), ...(roster?.taxi ?? [])]);
    const active = players.filter((id) => !parked.has(id)).length;
    if (active <= room) continue;
    notes.push(
      rosterId === mine.roster_id
        ? `${teamNameOf(bundle, rosterId)} would have ${active} players for ${room} active roster spots, so someone has to be dropped; list them under drop to include that.`
        : `${teamNameOf(bundle, rosterId)} would have ${active} players for ${room} active roster spots and has to drop someone, which this simulation leaves out.`,
    );
  }
  return notes;
}

interface Lineup {
  starters: (string | null)[];
  projected: Map<string, number>;
}

/** A roster's best projected lineup for one week; `players` replaces its player list. IR and taxi players never start. */
function bestLineup(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, projections: StatMap, players?: readonly string[]): Lineup {
  const scoring = bundle.league.scoring_settings;
  const unavailable = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])]);
  const candidates = (players ?? roster.players ?? []).filter((id) => !unavailable.has(id));
  const projected = new Map(candidates.map((id) => [id, scoreStatLine(projections[id] ?? null, scoring)]));
  return { starters: optimalStarters(ctx, bundle.league, candidates, projected), projected };
}

function lineupTotal(lineup: Lineup): number {
  return lineup.starters.reduce((sum, id) => sum + (id ? Math.max(0, lineup.projected.get(id) ?? 0) : 0), 0);
}

/** Projected score distribution for a roster's best lineup. */
function projectedWeek(ctx: ServerContext, bundle: LeagueBundle, roster: Roster, projections: StatMap, players?: readonly string[]): ScoreDistribution {
  const lineup = bestLineup(ctx, bundle, roster, projections, players);
  let mean = 0;
  let variance = 0;
  for (const id of lineup.starters) {
    const mu = id ? (lineup.projected.get(id) ?? 0) : 0;
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
