import { avatarUrl } from "./sleeper/client.js";
import type { League, LeagueUser, Roster, RosterSettings } from "./sleeper/types.js";

/** Starting slots and the positions eligible to fill them. */
export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
  DL: ["DL"],
  LB: ["LB"],
  DB: ["DB"],
  DE: ["DE", "DL"],
  DT: ["DT", "DL"],
  CB: ["CB", "DB"],
  S: ["S", "DB"],
};

const BENCH_SLOTS = new Set(["BN", "IR", "TAXI"]);

/** Starting slots in league order (roster_positions minus bench-type slots). */
export function startingSlots(league: Pick<League, "roster_positions">): string[] {
  return (league.roster_positions ?? []).filter((slot) => !BENCH_SLOTS.has(slot));
}

/** "QB, RB×2, WR×2, TE, FLEX, K, DEF, BN×6, IR×2" */
export function rosterShape(positions: string[] | null | undefined): string {
  if (!positions?.length) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < positions.length) {
    const slot = positions[i]!;
    let count = 1;
    while (positions[i + count] === slot) count++;
    parts.push(count > 1 ? `${slot}×${count}` : slot);
    i += count;
  }
  return parts.join(", ");
}

export interface ScoringSummary {
  format: "PPR" | "Half PPR" | "Standard" | string;
  reception_points: number;
  pass_td: number;
  pass_yd_per_point: number | null;
  te_premium: number;
  superflex: boolean;
  idp: boolean;
  best_ball: boolean;
  bonuses: Record<string, number>;
}

export function scoringSummary(league: Pick<League, "scoring_settings" | "roster_positions" | "settings">): ScoringSummary {
  const s = league.scoring_settings ?? {};
  const rec = num(s.rec);
  const format = rec >= 1 ? "PPR" : rec >= 0.5 ? "Half PPR" : rec > 0 ? `${rec} PPR` : "Standard";
  const positions = league.roster_positions ?? [];
  const bonuses: Record<string, number> = {};
  for (const [key, value] of Object.entries(s)) {
    if (key.startsWith("bonus_") && typeof value === "number" && value !== 0) bonuses[key] = value;
  }
  return {
    format,
    reception_points: rec,
    pass_td: num(s.pass_td),
    pass_yd_per_point: num(s.pass_yd) > 0 ? round(1 / num(s.pass_yd), 2) : null,
    te_premium: num(s.bonus_rec_te),
    superflex: positions.includes("SUPER_FLEX"),
    idp: positions.some((p) => ["IDP_FLEX", "DL", "LB", "DB", "DE", "DT", "CB", "S"].includes(p)),
    best_ball: league.settings?.best_ball === 1,
    bonuses,
  };
}

export function leagueType(league: Pick<League, "settings">): "redraft" | "keeper" | "dynasty" | "unknown" {
  switch (league.settings?.type) {
    case 0:
      return "redraft";
    case 1:
      return "keeper";
    case 2:
      return "dynasty";
    default:
      return "unknown";
  }
}

export function waiverType(league: Pick<League, "settings">): "rolling" | "reverse_standings" | "faab" | "unknown" {
  switch (league.settings?.waiver_type) {
    case 0:
      return "rolling";
    case 1:
      return "reverse_standings";
    case 2:
      return "faab";
    default:
      return "unknown";
  }
}

/** Compact league card used by list-style tools. */
export function leagueCard(league: League) {
  const scoring = scoringSummary(league);
  return {
    league_id: league.league_id,
    name: league.name,
    season: league.season,
    status: league.status,
    type: leagueType(league),
    teams: league.total_rosters,
    scoring: scoring.format + (scoring.superflex ? ", Superflex" : "") + (scoring.te_premium ? `, TE premium +${scoring.te_premium}` : ""),
    roster: rosterShape(league.roster_positions),
    draft_id: league.draft_id,
    previous_league_id: league.previous_league_id,
    avatar_url: avatarUrl(league.avatar),
  };
}

export function points(settings: RosterSettings | undefined, key: "fpts" | "fpts_against" | "ppts"): number {
  if (!settings) return 0;
  const whole = num(settings[key]);
  const decimal = num(settings[`${key}_decimal`]);
  return round(whole + decimal / 100, 2);
}

export function record(settings: RosterSettings | undefined): string {
  const w = num(settings?.wins);
  const l = num(settings?.losses);
  const t = num(settings?.ties);
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

export interface TeamRef {
  roster_id: number;
  team_name: string;
  manager: string | null;
  user_id: string | null;
}

/** Map roster_id -> human names, using league users for team names / display names. */
export function buildTeamIndex(rosters: Roster[], users: LeagueUser[]): Map<number, TeamRef> {
  const byUser = new Map(users.map((u) => [u.user_id, u]));
  const index = new Map<number, TeamRef>();
  for (const roster of rosters) {
    const user = roster.owner_id ? byUser.get(roster.owner_id) : undefined;
    const manager = user?.display_name ?? user?.username ?? null;
    const teamName = user?.metadata?.team_name?.trim() || (manager ? `Team ${manager}` : `Roster ${roster.roster_id}`);
    index.set(roster.roster_id, { roster_id: roster.roster_id, team_name: teamName, manager, user_id: roster.owner_id ?? null });
  }
  return index;
}

export function teamLabel(index: Map<number, TeamRef>, rosterId: number | null | undefined): string | null {
  if (rosterId === null || rosterId === undefined) return null;
  const team = index.get(rosterId);
  if (!team) return `Roster ${rosterId}`;
  return team.manager && team.manager !== team.team_name ? `${team.team_name} (${team.manager})` : team.team_name;
}

export function isoDate(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Sum a stat line against league scoring settings (how Sleeper computes fantasy points). */
export function scoreStatLine(stats: Record<string, number | null | undefined> | null | undefined, scoring: Record<string, number>): number {
  if (!stats) return 0;
  let total = 0;
  for (const [key, weight] of Object.entries(scoring)) {
    const value = stats[key];
    if (typeof value === "number" && typeof weight === "number" && weight !== 0) total += value * weight;
  }
  return round(total, 2);
}

/** Pick out the projection/stat columns worth showing for a position. */
export function keyStats(stats: Record<string, number | null | undefined> | null | undefined, pos: string | null): Record<string, number> {
  if (!stats) return {};
  const wanted = STAT_COLUMNS[pos ?? ""] ?? STAT_COLUMNS.DEFAULT!;
  const out: Record<string, number> = {};
  for (const key of wanted) {
    const v = stats[key];
    if (typeof v === "number" && v !== 0) out[key] = round(v, 2);
  }
  return out;
}

const STAT_COLUMNS: Record<string, string[]> = {
  QB: ["pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "rush_att", "rush_yd", "rush_td", "fum_lost"],
  RB: ["rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd", "rec_td", "fum_lost"],
  WR: ["rec_tgt", "rec", "rec_yd", "rec_td", "rush_att", "rush_yd", "rush_td", "fum_lost"],
  TE: ["rec_tgt", "rec", "rec_yd", "rec_td", "fum_lost"],
  K: ["fgm", "fga", "fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50p", "xpm", "xpa"],
  DEF: ["pts_allow", "yds_allow", "sack", "int", "fum_rec", "def_td", "safe", "blk_kick"],
  DEFAULT: ["pass_yd", "pass_td", "rush_yd", "rush_td", "rec", "rec_yd", "rec_td", "idp_tkl", "idp_sack", "idp_int"],
};
