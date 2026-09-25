/**
 * Synthetic Sleeper data for tests. Shapes mirror real API responses (see docs.sleeper.com).
 */
import type {
  BracketMatch,
  Draft,
  DraftPick,
  League,
  LeagueUser,
  Matchup,
  NflState,
  PlayerMap,
  Roster,
  ScheduleGame,
  SleeperUser,
  StatMap,
  TradedPick,
  Transaction,
  TrendingPlayer,
} from "../src/sleeper/types.js";

export const LEAGUE_ID = "1000000000000000001";
export const PREV_LEAGUE_ID = "1000000000000000000";
export const DRAFT_ID = "2000000000000000001";

export const state: NflState = {
  week: 5,
  leg: 5,
  season: "2026",
  season_type: "regular",
  season_start_date: "2026-09-10",
  previous_season: "2025",
  league_season: "2026",
  league_create_season: "2026",
  display_week: 5,
};

export const users: Record<string, SleeperUser> = {
  alice: { user_id: "111", username: "alice", display_name: "Alice", avatar: "abc123" },
  bob: { user_id: "222", username: "bob", display_name: "Bobby Tables", avatar: null },
  carol: { user_id: "333", username: "carol", display_name: "Carol", avatar: null },
  dave: { user_id: "444", username: "dave", display_name: "Dave", avatar: null },
};

export const players: PlayerMap = {
  "4046": p("4046", "Patrick", "Mahomes", "QB", "KC", { search_rank: 20, age: 31, years_exp: 9 }),
  "4984": p("4984", "Josh", "Allen", "QB", "BUF", { search_rank: 15, age: 30, years_exp: 8 }),
  "9226": p("9226", "Bijan", "Robinson", "RB", "ATL", { search_rank: 1, age: 24, years_exp: 3 }),
  "8138": p("8138", "Breece", "Hall", "RB", "NYJ", { search_rank: 12, age: 25, years_exp: 4 }),
  "6813": p("6813", "Jonathan", "Taylor", "RB", "IND", { search_rank: 8, age: 27, years_exp: 6, injury_status: "Questionable", injury_body_part: "Ankle" }),
  "7564": p("7564", "Ja'Marr", "Chase", "WR", "CIN", { search_rank: 2, age: 26, years_exp: 5 }),
  "6794": p("6794", "Justin", "Jefferson", "WR", "MIN", { search_rank: 3, age: 27, years_exp: 6 }),
  "8112": p("8112", "Drake", "London", "WR", "ATL", { search_rank: 14, age: 25, years_exp: 4 }),
  "5850": p("5850", "Travis", "Kelce", "TE", "KC", { search_rank: 40, age: 37, years_exp: 13, injury_status: "Out" }),
  "9509": p("9509", "Sam", "LaPorta", "TE", "DET", { search_rank: 30, age: 25, years_exp: 3 }),
  "4195": p("4195", "Harrison", "Butker", "K", "KC", { search_rank: 200 }),
  DET: p("DET", "Detroit", "Lions", "DEF", "DET", { search_rank: 300, fantasy_positions: ["DEF"] }),
  SF: p("SF", "San Francisco", "49ers", "DEF", "SF", { search_rank: 310, fantasy_positions: ["DEF"] }),
  // Free agents
  "11000": p("11000", "Rookie", "Runner", "RB", "GB", { search_rank: 90, age: 22, years_exp: 0 }),
  "11001": p("11001", "Handcuff", "Harry", "RB", "PHI", { search_rank: 120, age: 24, years_exp: 2 }),
  "11002": p("11002", "Streamer", "Steve", "QB", "SEA", { search_rank: 150, age: 28, years_exp: 5 }),
  "11003": p("11003", "Injured", "Ian", "WR", "LAR", { search_rank: 60, age: 26, years_exp: 3, injury_status: "IR" }),
  "11004": p("11004", "Retired", "Ron", "WR", null, { search_rank: 9999999, status: "Inactive", active: false }),
};

function p(id: string, first: string, last: string, pos: string, team: string | null, extra: Partial<PlayerMap[string]> = {}): PlayerMap[string] {
  return {
    player_id: id,
    first_name: first,
    last_name: last,
    full_name: pos === "DEF" ? undefined : `${first} ${last}`,
    position: pos,
    fantasy_positions: [pos],
    team,
    status: "Active",
    active: true,
    injury_status: null,
    age: null,
    years_exp: null,
    number: null,
    search_rank: null,
    search_full_name: `${first}${last}`.toLowerCase().replace(/[^a-z]/g, ""),
    ...extra,
  };
}

export const league: League = {
  league_id: LEAGUE_ID,
  name: "Test Dynasty",
  status: "in_season",
  sport: "nfl",
  season: "2026",
  season_type: "regular",
  total_rosters: 4,
  draft_id: DRAFT_ID,
  previous_league_id: PREV_LEAGUE_ID,
  avatar: null,
  settings: {
    num_teams: 4,
    playoff_teams: 2,
    playoff_week_start: 15,
    waiver_type: 2,
    waiver_budget: 100,
    trade_deadline: 12,
    type: 2,
    taxi_slots: 2,
    reserve_slots: 1,
    divisions: 2,
    leg: 5,
    last_scored_leg: 4,
  },
  scoring_settings: { pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, bonus_rec_te: 0.5, fum_lost: -2 },
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "IR", "TAXI", "TAXI"],
  metadata: { division_1: "East", division_2: "West" },
};

export const prevLeague: League = {
  ...league,
  league_id: PREV_LEAGUE_ID,
  season: "2025",
  status: "complete",
  previous_league_id: null,
  draft_id: "2000000000000000000",
};

export const leagueUsers: LeagueUser[] = [
  { ...users.alice!, is_owner: true, metadata: { team_name: "Alice's Avengers" } },
  { ...users.bob!, is_owner: false, metadata: {} },
  { ...users.carol!, is_owner: false, metadata: { team_name: "Carol Cartel" } },
  { ...users.dave!, is_owner: false, metadata: { team_name: "Dave Nation" } },
];

export const rosters: Roster[] = [
  {
    roster_id: 1,
    league_id: LEAGUE_ID,
    owner_id: "111",
    players: ["4046", "9226", "8138", "7564", "6794", "5850", "8112", "4195", "DET", "6813", "9509"],
    starters: ["4046", "9226", "8138", "7564", "6794", "5850", "8112", "4195", "DET"],
    reserve: null,
    taxi: null,
    settings: { wins: 3, losses: 1, ties: 0, fpts: 520, fpts_decimal: 50, fpts_against: 480, fpts_against_decimal: 10, waiver_position: 4, waiver_budget_used: 35, total_moves: 6, division: 1 },
    metadata: { streak: "2W" },
  },
  {
    roster_id: 2,
    league_id: LEAGUE_ID,
    owner_id: "222",
    players: ["4984", "SF"],
    starters: ["4984", "0", "0", "0", "0", "0", "0", "0", "SF"],
    reserve: null,
    taxi: null,
    settings: { wins: 3, losses: 1, ties: 0, fpts: 540, fpts_decimal: 0, fpts_against: 500, fpts_against_decimal: 0, waiver_position: 3, waiver_budget_used: 0, total_moves: 1, division: 1 },
    metadata: { streak: "1L" },
  },
  {
    roster_id: 3,
    league_id: LEAGUE_ID,
    owner_id: "333",
    players: [],
    starters: [],
    reserve: null,
    taxi: null,
    settings: { wins: 1, losses: 3, ties: 0, fpts: 400, fpts_decimal: 25, fpts_against: 450, fpts_against_decimal: 0, waiver_position: 1, waiver_budget_used: 80, total_moves: 9, division: 2 },
    metadata: {},
  },
  {
    roster_id: 4,
    league_id: LEAGUE_ID,
    owner_id: "444",
    players: [],
    starters: [],
    reserve: null,
    taxi: null,
    settings: { wins: 1, losses: 3, ties: 0, fpts: 380, fpts_decimal: 0, fpts_against: 410, fpts_against_decimal: 0, waiver_position: 2, waiver_budget_used: 10, total_moves: 2, division: 2 },
    metadata: {},
  },
];

export const matchupsWeek5: Matchup[] = [
  {
    roster_id: 1,
    matchup_id: 1,
    points: 128.4,
    custom_points: null,
    starters: rosters[0]!.starters,
    players: rosters[0]!.players,
    players_points: { "4046": 24.1, "9226": 22.3, "8138": 14.0, "7564": 19.5, "6794": 17.2, "5850": 0, "8112": 12.3, "4195": 9.0, DET: 10.0, "6813": 15.5, "9509": 8.8 },
  },
  { roster_id: 2, matchup_id: 1, points: 101.2, custom_points: null, starters: rosters[1]!.starters, players: rosters[1]!.players, players_points: { "4984": 29.2, SF: 12.0 } },
  { roster_id: 3, matchup_id: 2, points: 90.0, custom_points: null, starters: [], players: [], players_points: {} },
  { roster_id: 4, matchup_id: 2, points: 95.5, custom_points: null, starters: [], players: [], players_points: {} },
];

export const winnersBracket: BracketMatch[] = [
  { r: 1, m: 1, t1: 1, t2: 2, w: 1, l: 2, p: 1 },
];

export const transactionsWeek5: Transaction[] = [
  {
    transaction_id: "t1",
    type: "trade",
    status: "complete",
    status_updated: 1_760_000_000_000,
    created: 1_759_990_000_000,
    creator: "111",
    leg: 5,
    roster_ids: [1, 2],
    consenter_ids: [1, 2],
    adds: { "6813": 1, "8112": 2 },
    drops: { "6813": 2, "8112": 1 },
    draft_picks: [{ season: "2027", round: 2, roster_id: 2, previous_owner_id: 2, owner_id: 1 }],
    waiver_budget: [{ sender: 1, receiver: 2, amount: 15 }],
    settings: null,
    metadata: null,
  },
  {
    transaction_id: "t2",
    type: "waiver",
    status: "complete",
    status_updated: 1_759_900_000_000,
    created: 1_759_890_000_000,
    creator: "333",
    leg: 5,
    roster_ids: [3],
    consenter_ids: [3],
    adds: { "11000": 3 },
    drops: { "11004": 3 },
    draft_picks: [],
    waiver_budget: [],
    settings: { waiver_bid: 22, seq: 1 },
    metadata: null,
  },
  {
    transaction_id: "t3",
    type: "waiver",
    status: "failed",
    status_updated: 1_759_900_000_000,
    created: 1_759_890_000_000,
    creator: "444",
    leg: 5,
    roster_ids: [4],
    consenter_ids: [4],
    adds: { "11000": 4 },
    drops: null,
    draft_picks: [],
    waiver_budget: [],
    settings: { waiver_bid: 10, seq: 2 },
    metadata: { notes: "Outbid" },
  },
];

export const tradedPicks: TradedPick[] = [
  { season: "2027", round: 2, roster_id: 2, previous_owner_id: 2, owner_id: 1 },
  { season: "2027", round: 1, roster_id: 3, previous_owner_id: 3, owner_id: 4 },
];

export const draft: Draft = {
  draft_id: DRAFT_ID,
  league_id: LEAGUE_ID,
  type: "snake",
  status: "complete",
  sport: "nfl",
  season: "2026",
  season_type: "regular",
  start_time: 1_756_000_000_000,
  last_picked: 1_756_003_600_000,
  created: 1_755_000_000_000,
  settings: { teams: 4, rounds: 3, pick_timer: 90 },
  metadata: { scoring_type: "ppr", name: "Startup draft" },
  draft_order: { "111": 1, "222": 2, "333": 3, "444": 4 },
  slot_to_roster_id: { "1": 1, "2": 2, "3": 3, "4": 4 },
};

export const draftPicks: DraftPick[] = [
  { player_id: "9226", picked_by: "111", roster_id: 1, round: 1, draft_slot: 1, pick_no: 1, is_keeper: null, draft_id: DRAFT_ID, metadata: { position: "RB", team: "ATL" } },
  { player_id: "7564", picked_by: "222", roster_id: 2, round: 1, draft_slot: 2, pick_no: 2, is_keeper: null, draft_id: DRAFT_ID, metadata: { position: "WR", team: "CIN" } },
  { player_id: "6794", picked_by: "333", roster_id: 3, round: 1, draft_slot: 3, pick_no: 3, is_keeper: null, draft_id: DRAFT_ID, metadata: {} },
  { player_id: "4984", picked_by: "444", roster_id: 4, round: 1, draft_slot: 4, pick_no: 4, is_keeper: true, draft_id: DRAFT_ID, metadata: {} },
  { player_id: "4046", picked_by: "444", roster_id: 4, round: 2, draft_slot: 4, pick_no: 5, is_keeper: null, draft_id: DRAFT_ID, metadata: {} },
];

export const trendingAdd: TrendingPlayer[] = [
  { player_id: "11000", count: 12345 },
  { player_id: "11002", count: 4000 },
  { player_id: "6813", count: 900 },
];

export const projectionsWeek5: StatMap = {
  "4046": { pts_ppr: 21.5, pts_half_ppr: 21.5, pts_std: 21.5, pass_yd: 290, pass_td: 2.1, pass_int: 0.6, rush_yd: 15 },
  "4984": { pts_ppr: 23.9, pts_half_ppr: 23.9, pts_std: 23.9, pass_yd: 260, pass_td: 1.9, rush_yd: 40, rush_td: 0.5 },
  "9226": { pts_ppr: 19.8, pts_half_ppr: 17.5, pts_std: 15.2, rush_yd: 85, rush_td: 0.7, rec: 4.6, rec_yd: 35 },
  "8138": { pts_ppr: 13.0, pts_half_ppr: 11.5, pts_std: 10.0, rush_yd: 60, rush_td: 0.4, rec: 3, rec_yd: 20 },
  "6813": { pts_ppr: 16.9, pts_half_ppr: 15.9, pts_std: 14.9, rush_yd: 95, rush_td: 0.6, rec: 2, rec_yd: 12 },
  "7564": { pts_ppr: 20.1, pts_half_ppr: 16.6, pts_std: 13.1, rec: 7, rec_yd: 91, rec_td: 0.6 },
  "6794": { pts_ppr: 19.5, pts_half_ppr: 16, pts_std: 12.5, rec: 7, rec_yd: 95, rec_td: 0.5 },
  "8112": { pts_ppr: 14.2, pts_half_ppr: 11.7, pts_std: 9.2, rec: 5, rec_yd: 62, rec_td: 0.3 },
  "5850": { pts_ppr: 0, pts_half_ppr: 0, pts_std: 0 },
  "9509": { pts_ppr: 11.0, pts_half_ppr: 9, pts_std: 7, rec: 4, rec_yd: 45, rec_td: 0.35 },
  "4195": { pts_ppr: 8.5, pts_half_ppr: 8.5, pts_std: 8.5, fgm: 1.8, xpm: 2.6 },
  DET: { pts_ppr: 7.2, pts_half_ppr: 7.2, pts_std: 7.2, sack: 2.5, int: 0.8 },
  SF: { pts_ppr: 6.1, pts_half_ppr: 6.1, pts_std: 6.1, sack: 2.1 },
  "11000": { pts_ppr: 9.9, pts_half_ppr: 8.4, pts_std: 6.9, rush_yd: 50, rec: 3 },
};

export const statsWeek4: StatMap = {
  "4046": { pts_ppr: 24.1, pts_half_ppr: 24.1, pts_std: 24.1, pass_yd: 310, pass_td: 3, pass_int: 1, gp: 1 },
  "9226": { pts_ppr: 22.3, pts_half_ppr: 20.3, pts_std: 18.3, rush_yd: 103, rush_td: 1, rec: 4, rec_yd: 40, gp: 1 },
};

/** The schedule lives outside /v1, so its route key is the absolute URL. */
export const SCHEDULE_URL = "https://api.sleeper.app/schedule/nfl/regular/2026";

/** Week 5 mid-Sunday: KC-BUF final, ATL-NYJ live, CIN-MIN and DET-SF still to play, IND on bye, one canceled listing. */
export const schedule2026: ScheduleGame[] = [
  { game_id: "202650001", week: 5, date: "2026-10-08", home: "KC", away: "BUF", status: "complete" },
  { game_id: "202650002", week: 5, date: "2026-10-11", home: "ATL", away: "NYJ", status: "in_game" },
  { game_id: "202650003", week: 5, date: "2026-10-11", home: "CIN", away: "MIN", status: "pre_game" },
  { game_id: "202650004", week: 5, date: "2026-10-11", home: "DET", away: "SF", status: "pre_game" },
  { game_id: "202650005", week: 5, date: "2026-10-11", home: "LAR", away: "SEA", status: "canceled" },
  { game_id: "202660001", week: 6, date: "2026-10-18", home: "IND", away: "KC", status: "pre_game" },
];

/** Alice vs Bob in week 5 while those games are on: KC players final, ATL/NYJ live, CIN/MIN/DET to come. */
export const liveMatchupsWeek5: Matchup[] = [
  {
    roster_id: 1,
    matchup_id: 1,
    points: 54.1,
    custom_points: null,
    starters: rosters[0]!.starters,
    players: rosters[0]!.players,
    players_points: { "4046": 24.1, "9226": 10, "8138": 6, "7564": 0, "6794": 0, "5850": 0, "8112": 5, "4195": 9, DET: 0, "6813": 0, "9509": 0 },
  },
  { roster_id: 2, matchup_id: 1, points: 29.2, custom_points: null, starters: rosters[1]!.starters, players: rosters[1]!.players, players_points: { "4984": 29.2, SF: 0 } },
  { roster_id: 3, matchup_id: 2, points: 0, custom_points: null, starters: [], players: [], players_points: {} },
  { roster_id: 4, matchup_id: 2, points: 0, custom_points: null, starters: [], players: [], players_points: {} },
];

/** Box scores while ATL-NYJ is live: ATL has run 48 of a typical 64 offensive snaps; NYJ has no stat lines yet. */
export const liveStatsWeek5: StatMap = { "9226": { rush_att: 9, rush_yd: 50, tm_off_snp: 48 } };

/** Route table: path (without base) -> body. Query strings are matched exactly where present. */
export function routes(): Record<string, unknown> {
  return {
    "/state/nfl": state,
    "/user/alice": users.alice,
    "/user/111": users.alice,
    "/user/bob": users.bob,
    "/user/222": users.bob,
    "/user/carol": users.carol,
    "/user/dave": users.dave,
    "/user/nobody": null,
    "/user/111/leagues/nfl/2026": [league],
    "/user/111/leagues/nfl/2025": [prevLeague],
    "/user/111/drafts/nfl/2026": [draft],
    [`/league/${LEAGUE_ID}`]: league,
    [`/league/${LEAGUE_ID}/rosters`]: rosters,
    [`/league/${LEAGUE_ID}/users`]: leagueUsers,
    [`/league/${LEAGUE_ID}/matchups/5`]: matchupsWeek5,
    [`/league/${LEAGUE_ID}/matchups/6`]: [],
    [`/league/${LEAGUE_ID}/winners_bracket`]: [],
    [`/league/${LEAGUE_ID}/losers_bracket`]: [],
    [`/league/${LEAGUE_ID}/transactions/5`]: transactionsWeek5,
    [`/league/${LEAGUE_ID}/transactions/4`]: [],
    [`/league/${LEAGUE_ID}/transactions/3`]: [],
    [`/league/${LEAGUE_ID}/transactions/2`]: [],
    [`/league/${LEAGUE_ID}/transactions/1`]: [],
    [`/league/${LEAGUE_ID}/traded_picks`]: tradedPicks,
    [`/league/${LEAGUE_ID}/drafts`]: [draft],
    [`/league/${PREV_LEAGUE_ID}`]: prevLeague,
    [`/league/${PREV_LEAGUE_ID}/rosters`]: rosters.map((r) => ({ ...r, league_id: PREV_LEAGUE_ID })),
    [`/league/${PREV_LEAGUE_ID}/users`]: leagueUsers,
    [`/league/${PREV_LEAGUE_ID}/winners_bracket`]: winnersBracket,
    "/league/404404404": null,
    [`/draft/${DRAFT_ID}`]: draft,
    [`/draft/${DRAFT_ID}/picks`]: draftPicks,
    "/players/nfl": players,
    "/players/nfl/trending/add?lookback_hours=24&limit=25": trendingAdd,
    "/players/nfl/trending/add?lookback_hours=24&limit=100": trendingAdd,
    "/players/nfl/trending/drop?lookback_hours=24&limit=25": [{ player_id: "5850", count: 5000 }],
    "/projections/nfl/regular/2026/5": projectionsWeek5,
    "/projections/nfl/regular/2026": projectionsWeek5,
    "/stats/nfl/regular/2026/4": statsWeek4,
    "/stats/nfl/regular/2026/5": {},
    [SCHEDULE_URL]: schedule2026,
  };
}
