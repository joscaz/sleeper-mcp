/**
 * NFL game states for one week: which games are final, live or still to come, and how much of a
 * live game is left. Shared by the live odds tools and the start/sit analysis, which both need to
 * tell points already scored apart from points still to play for.
 */
import type { ServerContext } from "./context.js";
import { TTL } from "./sleeper/client.js";
import { isTeamDefense } from "./sleeper/players.js";
import type { NflState, ScheduleGame, StatMap } from "./sleeper/types.js";
import { num } from "./format.js";

/** Offensive snaps one team runs in a typical NFL game; used to estimate how far along a live game is. */
const TYPICAL_TEAM_SNAPS = 64;

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

/** Sleeper locks a player once his game kicks off (final or still being played). */
export function hasKickedOff(game: TeamGame): boolean {
  return game.state === "final" || game.state === "playing";
}

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
    const team = nflTeam(ctx, id);
    if (team && s > (snaps.get(team) ?? 0)) snaps.set(team, s);
  }
  return new Map([...snaps].map(([team, s]) => [team, Math.min(1, s / TYPICAL_TEAM_SNAPS)]));
}

/** The NFL team whose game a player's points come from (team defenses are keyed by their team code). */
export function nflTeam(ctx: ServerContext, playerId: string): string | null {
  return ctx.players.raw(playerId)?.team ?? (isTeamDefense(playerId) ? playerId : null);
}
