/**
 * Types for the Sleeper public API (https://docs.sleeper.com).
 * Only the fields this server relies on are typed strictly; everything else is kept loose
 * because Sleeper adds fields without notice.
 */

export type Sport = "nfl";

export interface SleeperUser {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
  is_bot?: boolean | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type LeagueStatus = "pre_draft" | "drafting" | "in_season" | "complete" | string;

export interface League {
  league_id: string;
  name: string;
  status: LeagueStatus;
  sport: string;
  season: string;
  season_type: string;
  total_rosters: number;
  draft_id: string | null;
  previous_league_id: string | null;
  avatar: string | null;
  settings: LeagueSettings;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  metadata?: Record<string, unknown> | null;
  bracket_id?: number | null;
  loser_bracket_id?: number | null;
  [key: string]: unknown;
}

export interface LeagueSettings {
  num_teams?: number;
  playoff_teams?: number;
  playoff_week_start?: number;
  playoff_type?: number;
  playoff_round_type?: number;
  playoff_seed_type?: number;
  waiver_type?: number; // 0 rolling, 1 reverse standings, 2 FAAB
  waiver_budget?: number;
  waiver_day_of_week?: number;
  waiver_clear_days?: number;
  trade_deadline?: number;
  type?: number; // 0 redraft, 1 keeper, 2 dynasty
  taxi_slots?: number;
  reserve_slots?: number;
  max_keepers?: number;
  divisions?: number;
  leg?: number;
  last_scored_leg?: number;
  best_ball?: number;
  league_average_match?: number;
  daily_waivers?: number;
  [key: string]: unknown;
}

export interface RosterSettings {
  wins?: number;
  losses?: number;
  ties?: number;
  fpts?: number;
  fpts_decimal?: number;
  fpts_against?: number;
  fpts_against_decimal?: number;
  ppts?: number;
  ppts_decimal?: number;
  waiver_position?: number;
  waiver_budget_used?: number;
  total_moves?: number;
  division?: number;
  [key: string]: unknown;
}

export interface Roster {
  roster_id: number;
  league_id: string;
  owner_id: string | null;
  co_owners?: string[] | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi?: string[] | null;
  settings: RosterSettings;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface LeagueUser extends SleeperUser {
  league_id?: string;
  is_owner?: boolean | null; // commissioner
  metadata?: { team_name?: string; [key: string]: unknown } | null;
}

export interface Matchup {
  roster_id: number;
  matchup_id: number | null;
  points: number | null;
  custom_points: number | null;
  starters: string[] | null;
  starters_points?: number[] | null;
  players: string[] | null;
  players_points?: Record<string, number> | null;
  [key: string]: unknown;
}

export interface BracketSource {
  w?: number;
  l?: number;
}

export interface BracketMatch {
  r: number;
  m: number;
  t1: number | null;
  t2: number | null;
  w: number | null;
  l: number | null;
  t1_from?: BracketSource | null;
  t2_from?: BracketSource | null;
  p?: number | null; // place being played for (1 = championship, 3 = third place, ...)
}

export type TransactionType = "trade" | "waiver" | "free_agent" | "commissioner" | string;

export interface TransactionDraftPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
}

export interface Transaction {
  transaction_id: string;
  type: TransactionType;
  status: string;
  status_updated: number | null;
  created: number;
  creator: string | null;
  leg: number;
  roster_ids: number[] | null;
  consenter_ids: number[] | null;
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: TransactionDraftPick[] | null;
  waiver_budget: { sender: number; receiver: number; amount: number }[] | null;
  settings: { waiver_bid?: number; seq?: number; [key: string]: unknown } | null;
  metadata: { notes?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export interface TradedPick {
  season: string;
  round: number;
  roster_id: number; // original owner
  previous_owner_id: number;
  owner_id: number; // current owner
}

export interface NflState {
  week: number;
  leg: number;
  season: string;
  season_type: "pre" | "regular" | "post" | string;
  season_start_date: string | null;
  previous_season: string;
  league_season: string;
  league_create_season: string;
  display_week: number;
  season_has_scores?: boolean;
  [key: string]: unknown;
}

export interface Draft {
  draft_id: string;
  league_id: string | null;
  type: "snake" | "linear" | "auction" | string;
  status: "pre_draft" | "drafting" | "paused" | "complete" | string;
  sport: string;
  season: string;
  season_type: string;
  start_time: number | null;
  last_picked: number | null;
  created: number;
  settings: {
    teams?: number;
    rounds?: number;
    pick_timer?: number;
    budget?: number;
    reversal_round?: number;
    [key: string]: unknown;
  };
  metadata?: { scoring_type?: string; name?: string; description?: string; [key: string]: unknown } | null;
  draft_order: Record<string, number> | null; // user_id -> slot
  slot_to_roster_id: Record<string, number> | null;
  [key: string]: unknown;
}

export interface DraftPick {
  player_id: string;
  picked_by: string; // user_id, may be ""
  roster_id: number | string | null;
  round: number;
  draft_slot: number;
  pick_no: number;
  is_keeper: boolean | null;
  draft_id: string;
  metadata?: {
    first_name?: string;
    last_name?: string;
    position?: string;
    team?: string;
    amount?: string; // auction price
    injury_status?: string;
    status?: string;
    years_exp?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface Player {
  player_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name?: string | null;
  position: string | null;
  fantasy_positions: string[] | null;
  team: string | null;
  status: string | null; // Active, Inactive, Injured Reserve, ...
  active?: boolean | null;
  injury_status: string | null; // Questionable, Doubtful, Out, IR, PUP, ...
  injury_body_part?: string | null;
  injury_notes?: string | null;
  injury_start_date?: string | null;
  practice_participation?: string | null;
  practice_description?: string | null;
  age: number | null;
  years_exp: number | null;
  number: number | null;
  height?: string | null;
  weight?: string | null;
  college?: string | null;
  depth_chart_position?: string | null;
  depth_chart_order?: number | null;
  search_rank: number | null;
  search_full_name?: string | null;
  search_first_name?: string | null;
  search_last_name?: string | null;
  news_updated?: number | null;
  birth_date?: string | null;
  espn_id?: number | string | null;
  yahoo_id?: number | string | null;
  rotowire_id?: number | string | null;
  sportradar_id?: string | null;
  gsis_id?: string | null;
  [key: string]: unknown;
}

export type PlayerMap = Record<string, Player>;

export interface TrendingPlayer {
  player_id: string;
  count: number;
}

/** Stat line as returned by the (undocumented) stats/projections endpoints. */
export type StatLine = Record<string, number | null | undefined>;
export type StatMap = Record<string, StatLine | null>;
