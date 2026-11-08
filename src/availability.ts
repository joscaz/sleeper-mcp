import type { NflState } from "./sleeper/types.js";
import { hasKickedOff, type TeamGame } from "./games.js";

/** Shared Sleeper designations; Questionable and Doubtful are risks, not ruled out. */
export const RULED_OUT = /^(out|ir|pup|sus|nfi|na|dnr|cov)\b/i;

export const AVAILABILITY_POLICY =
  "For the current regular-season week only, a Sleeper ruled-out designation (Out, IR, PUP, Sus, NFI, NA, DNR or COV) zeros the pre-kickoff projection and excludes unlocked players from the optimal lineup. Questionable, Doubtful and optional ESPN reports do not adjust points. Source conflicts require review, not medical clearance. Once a game starts, scored points and the live projection are preserved; current injury flags are not historical or future-week evidence.";

export function currentInjuryWeek(season: string, week: number, state: NflState): boolean {
  return season === state.season && week === state.week && state.season_type === "regular";
}

/** Never let optional news change the Sleeper model, or erase points after kickoff. */
export function ruledOutBeforeKickoff(designation: string | null | undefined, game: TeamGame, currentWeek: boolean): boolean {
  return currentWeek && !hasKickedOff(game) && RULED_OUT.test(designation ?? "");
}

export function availableProjection(projection: number, designation: string | null | undefined, game: TeamGame, currentWeek: boolean): number {
  return ruledOutBeforeKickoff(designation, game, currentWeek) ? 0 : projection;
}
