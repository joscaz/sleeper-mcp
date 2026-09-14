import { SleeperClient, SleeperNotFoundError } from "./sleeper/client.js";
import { SleeperGraphqlClient } from "./sleeper/graphql.js";
import { PlayerStore } from "./sleeper/players.js";
import type { League, LeagueUser, NflState, Roster, Sport } from "./sleeper/types.js";
import { buildTeamIndex, type TeamRef } from "./format.js";

export interface ServerContext {
  client: SleeperClient;
  players: PlayerStore;
  log: (message: string) => void;
  /** Username or user_id assumed when a tool is called without a user/team selector ("my team"). */
  defaultUser: string | null;
  /** Authenticated Sleeper session (private GraphQL API); null when no credentials are configured. */
  auth: SleeperGraphqlClient | null;
  /** Whether tools that change the account (lineup, waivers, trades, ...) are registered. */
  allowWrites: boolean;
}

export interface ContextOptions {
  client?: SleeperClient;
  players?: PlayerStore;
  log?: (message: string) => void;
  cacheDir?: string | null;
  /** Default Sleeper username or user_id (CLI --user / SLEEPER_USERNAME). */
  defaultUser?: string | null;
  /** Pre-built authenticated client (tests), or credentials to build one. */
  auth?: SleeperGraphqlClient | null;
  /** Session JWT for Sleeper's private API (SLEEPER_TOKEN). */
  authToken?: string | null;
  /** Username/email + password login instead of a token (SLEEPER_EMAIL / SLEEPER_PASSWORD). */
  authEmail?: string | null;
  authPassword?: string | null;
  /** Register write tools when a session exists (default true; CLI --read-only disables). */
  allowWrites?: boolean;
}

export function createContext(options: ContextOptions = {}): ServerContext {
  const log = options.log ?? ((message: string) => console.error(`[sleeper-mcp] ${message}`));
  const client = options.client ?? new SleeperClient();
  const players = options.players ?? new PlayerStore(client, { cacheDir: options.cacheDir, log });
  const defaultUser = options.defaultUser?.trim() || null;
  let auth: SleeperGraphqlClient | null = options.auth ?? null;
  if (!auth && (options.authToken?.trim() || (options.authEmail?.trim() && options.authPassword))) {
    auth = new SleeperGraphqlClient({ token: options.authToken, email: options.authEmail, password: options.authPassword, log });
  }
  const allowWrites = Boolean(auth) && (options.allowWrites ?? true);
  return { client, players, log, defaultUser, auth, allowWrites };
}

/** Thrown for user-facing problems (bad input, unknown league, ...). The message is shown to the model verbatim. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface UserSelector {
  username?: string;
  user_id?: string;
}

export interface TeamSelector extends UserSelector {
  roster_id?: number;
  team_name?: string;
}

const NUMERIC_ID = /^\d{6,}$/;

export const NO_USER_HINT = "Provide a Sleeper username or user_id (or start the server with --user / SLEEPER_USERNAME so \"my\" questions resolve automatically).";

/** Resolve a username or user_id to a canonical user_id, falling back to the configured default user. */
export async function resolveUserId(ctx: ServerContext, sel: UserSelector): Promise<string> {
  const raw = (sel.user_id ?? sel.username ?? ctx.defaultUser ?? "").trim();
  if (!raw) throw new ToolError(NO_USER_HINT);
  if (NUMERIC_ID.test(raw)) return raw;
  try {
    const user = await ctx.client.getUser(raw);
    return user.user_id;
  } catch (err) {
    if (err instanceof SleeperNotFoundError) {
      throw new ToolError(`No Sleeper user named "${raw}". Usernames are case-insensitive; double-check the spelling or pass a numeric user_id.`);
    }
    throw err;
  }
}

export async function resolveSeason(ctx: ServerContext, season: string | number | undefined, sport: Sport = "nfl"): Promise<string> {
  if (season !== undefined && season !== null && String(season).trim() !== "") return String(season).trim();
  const state = await ctx.client.getNflState(sport);
  return state.league_season ?? state.season;
}

/** Default to the current NFL week (1 when the regular season has not started). */
export async function resolveWeek(ctx: ServerContext, week: number | undefined, state?: NflState): Promise<{ week: number; state: NflState }> {
  const st = state ?? (await ctx.client.getNflState("nfl"));
  if (week !== undefined) return { week, state: st };
  const current = st.season_type === "regular" || st.season_type === "post" ? st.week || st.leg || 1 : 1;
  return { week: Math.max(1, current), state: st };
}

export interface LeagueBundle {
  league: League;
  rosters: Roster[];
  users: LeagueUser[];
  teams: Map<number, TeamRef>;
}

/** League + rosters + users, fetched in parallel (all cached). */
export async function loadLeague(ctx: ServerContext, leagueId: string): Promise<LeagueBundle> {
  const id = leagueId.trim();
  if (!id) throw new ToolError("league_id is required.");
  try {
    const [league, rosters, users] = await Promise.all([ctx.client.getLeague(id), ctx.client.getRosters(id), ctx.client.getLeagueUsers(id)]);
    return { league, rosters, users, teams: buildTeamIndex(rosters, users) };
  } catch (err) {
    if (err instanceof SleeperNotFoundError) {
      throw new ToolError(`League ${id} was not found. Use get_user_leagues to list a manager's league IDs.`);
    }
    throw err;
  }
}

/**
 * Find one roster in a league by roster_id, user_id, username or (fuzzy) team name.
 * With no selector at all, the configured default user is used.
 */
export async function resolveRoster(ctx: ServerContext, bundle: LeagueBundle, sel: TeamSelector): Promise<Roster> {
  const { rosters, users, teams } = bundle;

  if (sel.roster_id === undefined && !sel.user_id && !sel.username && !sel.team_name && ctx.defaultUser) {
    sel = { username: ctx.defaultUser };
  }

  if (sel.roster_id !== undefined) {
    const roster = rosters.find((r) => r.roster_id === sel.roster_id);
    if (!roster) throw new ToolError(`No roster_id ${sel.roster_id} in league ${bundle.league.league_id} (valid: 1-${rosters.length}).`);
    return roster;
  }

  if (sel.user_id || sel.username) {
    const raw = (sel.user_id ?? sel.username ?? "").trim();
    // Try to match league members locally first (saves a request and tolerates display names).
    const lower = raw.toLowerCase();
    const member = users.find(
      (u) => u.user_id === raw || u.username?.toLowerCase() === lower || u.display_name?.toLowerCase() === lower,
    );
    const userId = member?.user_id ?? (await resolveUserId(ctx, sel));
    const roster = rosters.find((r) => r.owner_id === userId || r.co_owners?.includes(userId));
    if (!roster) {
      throw new ToolError(`User "${raw}" is not a manager in league "${bundle.league.name}" (${bundle.league.league_id}).`);
    }
    return roster;
  }

  if (sel.team_name) {
    const q = sel.team_name.trim().toLowerCase();
    const exact = [...teams.values()].find((t) => t.team_name.toLowerCase() === q || t.manager?.toLowerCase() === q);
    const partial = exact ?? [...teams.values()].find((t) => t.team_name.toLowerCase().includes(q) || t.manager?.toLowerCase().includes(q));
    const roster = partial ? rosters.find((r) => r.roster_id === partial.roster_id) : undefined;
    if (!roster) {
      const names = [...teams.values()].map((t) => `${t.team_name}${t.manager ? ` (${t.manager})` : ""}`).join("; ");
      throw new ToolError(`No team matching "${sel.team_name}". Teams in this league: ${names}`);
    }
    return roster;
  }

  throw new ToolError(`Identify the team with one of: roster_id, username, user_id or team_name. ${NO_USER_HINT}`);
}
