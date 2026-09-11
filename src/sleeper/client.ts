import { TtlCache } from "./cache.js";
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
  SleeperUser,
  Sport,
  StatMap,
  TradedPick,
  Transaction,
  TrendingPlayer,
} from "./types.js";

export const SLEEPER_API_BASE = "https://api.sleeper.app/v1";
export const SLEEPER_CDN_BASE = "https://sleepercdn.com";

export class SleeperApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "SleeperApiError";
  }
}

export class SleeperNotFoundError extends SleeperApiError {
  constructor(path: string, what = "resource") {
    super(`Sleeper ${what} not found (${path})`, 404, path);
    this.name = "SleeperNotFoundError";
  }
}

export interface SleeperClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  cache?: TtlCache;
  userAgent?: string;
  /** Soft cap on outbound requests per minute. Sleeper asks to stay under 1000. */
  maxRequestsPerMinute?: number;
  /** Retries for 429/5xx/network failures (with exponential backoff). */
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Default cache TTLs (ms) per data class. */
export const TTL = {
  user: 10 * 60_000,
  leagueList: 5 * 60_000,
  league: 60_000,
  rosters: 30_000,
  users: 5 * 60_000,
  matchups: 20_000,
  bracket: 60_000,
  transactions: 30_000,
  tradedPicks: 5 * 60_000,
  state: 5 * 60_000,
  drafts: 60_000,
  draftPicks: 15_000,
  players: 24 * 60 * 60_000,
  trending: 5 * 60_000,
  stats: 5 * 60_000,
  projections: 30 * 60_000,
} as const;

interface GetOptions {
  ttlMs?: number;
  /** Description used in not-found errors, e.g. "league". */
  what?: string;
  /** If true, a null/404 response resolves to null instead of throwing. */
  nullable?: boolean;
}

/**
 * Thin, cached, rate-limited client for the Sleeper read-only API.
 */
export class SleeperClient {
  readonly baseUrl: string;
  readonly cache: TtlCache;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRpm: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly requestLog: number[] = [];
  private requestCount = 0;

  constructor(options: SleeperClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? SLEEPER_API_BASE).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.cache = options.cache ?? new TtlCache();
    this.userAgent = options.userAgent ?? "sleeper-mcp (+https://github.com/joscaz/sleeper-mcp)";
    this.maxRpm = options.maxRequestsPerMinute ?? 600;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; Node.js 20+ is required.");
    }
  }

  /** Number of HTTP requests actually sent (cache misses). Useful for tests and diagnostics. */
  get requestsSent(): number {
    return this.requestCount;
  }

  // ---------------------------------------------------------------------------
  // Core request plumbing
  // ---------------------------------------------------------------------------

  private async throttle(): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const cutoff = this.now() - windowMs;
      while (this.requestLog.length && (this.requestLog[0] ?? 0) < cutoff) this.requestLog.shift();
      if (this.requestLog.length < this.maxRpm) {
        this.requestLog.push(this.now());
        return;
      }
      const waitFor = (this.requestLog[0] ?? this.now()) + windowMs - this.now() + 5;
      await this.sleep(Math.max(waitFor, 50));
    }
  }

  private async rawGet(path: string): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      await this.throttle();
      this.requestCount++;
      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          response = await this.fetchImpl(url, {
            headers: { accept: "application/json", "user-agent": this.userAgent },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt++));
          continue;
        }
        throw new SleeperApiError(`Network error calling Sleeper: ${(err as Error).message}`, 0, path);
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
          attempt++;
          await this.sleep(wait);
          continue;
        }
        throw new SleeperApiError(
          response.status === 429
            ? "Sleeper rate limit hit (HTTP 429). Slow down and retry shortly."
            : `Sleeper API error (HTTP ${response.status})`,
          response.status,
          path,
        );
      }

      if (response.status === 404) return { status: 404, body: null };
      if (!response.ok) {
        const text = await safeText(response);
        throw new SleeperApiError(`Sleeper API error (HTTP ${response.status})${text ? `: ${text}` : ""}`, response.status, path);
      }
      const text = await response.text();
      if (!text || text === "null") return { status: response.status, body: null };
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        throw new SleeperApiError(`Sleeper returned non-JSON for ${path}`, response.status, path);
      }
    }
  }

  /**
   * GET a JSON resource. Results are cached by path for `ttlMs`.
   * Sleeper answers unknown IDs with either HTTP 404 or a literal `null` body; both map to not-found.
   */
  async get<T>(path: string, options: GetOptions & { nullable: true }): Promise<T | null>;
  async get<T>(path: string, options?: GetOptions): Promise<T>;
  async get<T>(path: string, options: GetOptions = {}): Promise<T | null> {
    const ttl = options.ttlMs ?? 30_000;
    const value = await this.cache.getOrLoad<{ body: unknown }>(`GET ${path}`, ttl, async () => {
      const { body } = await this.rawGet(path);
      return { body };
    });
    if (value.body === null || value.body === undefined) {
      if (options.nullable) return null;
      throw new SleeperNotFoundError(path, options.what);
    }
    return value.body as T;
  }

  // ---------------------------------------------------------------------------
  // Users & leagues
  // ---------------------------------------------------------------------------

  /** Look up a user by username (case-insensitive) or numeric user_id. */
  getUser(usernameOrId: string): Promise<SleeperUser> {
    return this.get<SleeperUser>(`/user/${encodeURIComponent(usernameOrId.trim())}`, { ttlMs: TTL.user, what: "user" });
  }

  async getUserLeagues(userId: string, sport: Sport, season: string): Promise<League[]> {
    return (await this.get<League[]>(`/user/${enc(userId)}/leagues/${sport}/${enc(season)}`, { ttlMs: TTL.leagueList, nullable: true })) ?? [];
  }

  getLeague(leagueId: string): Promise<League> {
    return this.get<League>(`/league/${enc(leagueId)}`, { ttlMs: TTL.league, what: "league" });
  }

  async getRosters(leagueId: string): Promise<Roster[]> {
    return (await this.get<Roster[]>(`/league/${enc(leagueId)}/rosters`, { ttlMs: TTL.rosters, nullable: true })) ?? [];
  }

  async getLeagueUsers(leagueId: string): Promise<LeagueUser[]> {
    return (await this.get<LeagueUser[]>(`/league/${enc(leagueId)}/users`, { ttlMs: TTL.users, nullable: true })) ?? [];
  }

  async getMatchups(leagueId: string, week: number): Promise<Matchup[]> {
    return (await this.get<Matchup[]>(`/league/${enc(leagueId)}/matchups/${week}`, { ttlMs: TTL.matchups, nullable: true })) ?? [];
  }

  async getWinnersBracket(leagueId: string): Promise<BracketMatch[]> {
    return (await this.get<BracketMatch[]>(`/league/${enc(leagueId)}/winners_bracket`, { ttlMs: TTL.bracket, nullable: true })) ?? [];
  }

  async getLosersBracket(leagueId: string): Promise<BracketMatch[]> {
    return (await this.get<BracketMatch[]>(`/league/${enc(leagueId)}/losers_bracket`, { ttlMs: TTL.bracket, nullable: true })) ?? [];
  }

  async getTransactions(leagueId: string, week: number): Promise<Transaction[]> {
    return (await this.get<Transaction[]>(`/league/${enc(leagueId)}/transactions/${week}`, { ttlMs: TTL.transactions, nullable: true })) ?? [];
  }

  async getTradedPicks(leagueId: string): Promise<TradedPick[]> {
    return (await this.get<TradedPick[]>(`/league/${enc(leagueId)}/traded_picks`, { ttlMs: TTL.tradedPicks, nullable: true })) ?? [];
  }

  getNflState(sport: Sport = "nfl"): Promise<NflState> {
    return this.get<NflState>(`/state/${sport}`, { ttlMs: TTL.state, what: "sport state" });
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  async getUserDrafts(userId: string, sport: Sport, season: string): Promise<Draft[]> {
    return (await this.get<Draft[]>(`/user/${enc(userId)}/drafts/${sport}/${enc(season)}`, { ttlMs: TTL.drafts, nullable: true })) ?? [];
  }

  async getLeagueDrafts(leagueId: string): Promise<Draft[]> {
    return (await this.get<Draft[]>(`/league/${enc(leagueId)}/drafts`, { ttlMs: TTL.drafts, nullable: true })) ?? [];
  }

  getDraft(draftId: string): Promise<Draft> {
    return this.get<Draft>(`/draft/${enc(draftId)}`, { ttlMs: TTL.drafts, what: "draft" });
  }

  async getDraftPicks(draftId: string): Promise<DraftPick[]> {
    return (await this.get<DraftPick[]>(`/draft/${enc(draftId)}/picks`, { ttlMs: TTL.draftPicks, nullable: true })) ?? [];
  }

  async getDraftTradedPicks(draftId: string): Promise<TradedPick[]> {
    return (await this.get<TradedPick[]>(`/draft/${enc(draftId)}/traded_picks`, { ttlMs: TTL.tradedPicks, nullable: true })) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------------

  /** The full ~5 MB player map. Prefer PlayerStore, which persists this to disk. */
  getAllPlayers(sport: Sport = "nfl"): Promise<PlayerMap> {
    return this.get<PlayerMap>(`/players/${sport}`, { ttlMs: TTL.players, what: "player map" });
  }

  async getTrendingPlayers(sport: Sport, type: "add" | "drop", lookbackHours = 24, limit = 25): Promise<TrendingPlayer[]> {
    const qs = new URLSearchParams({ lookback_hours: String(lookbackHours), limit: String(limit) });
    return (await this.get<TrendingPlayer[]>(`/players/${sport}/trending/${type}?${qs}`, { ttlMs: TTL.trending, nullable: true })) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Stats & projections (undocumented but long-lived endpoints)
  // ---------------------------------------------------------------------------

  /** Weekly (or season, when week is omitted) stat lines keyed by player_id. */
  async getStats(sport: Sport, seasonType: string, season: string, week?: number): Promise<StatMap> {
    const path = week === undefined ? `/stats/${sport}/${seasonType}/${enc(season)}` : `/stats/${sport}/${seasonType}/${enc(season)}/${week}`;
    return (await this.get<StatMap>(path, { ttlMs: TTL.stats, nullable: true })) ?? {};
  }

  /** Weekly (or season, when week is omitted) projections keyed by player_id. */
  async getProjections(sport: Sport, seasonType: string, season: string, week?: number): Promise<StatMap> {
    const path =
      week === undefined ? `/projections/${sport}/${seasonType}/${enc(season)}` : `/projections/${sport}/${seasonType}/${enc(season)}/${week}`;
    return (await this.get<StatMap>(path, { ttlMs: TTL.projections, nullable: true })) ?? {};
  }
}

function enc(value: string | number): string {
  return encodeURIComponent(String(value).trim());
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 300 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

export function avatarUrl(avatarId: string | null | undefined, thumb = false): string | null {
  if (!avatarId) return null;
  return `${SLEEPER_CDN_BASE}/avatars/${thumb ? "thumbs/" : ""}${avatarId}`;
}

export function playerHeadshotUrl(playerId: string): string {
  // Team defenses use a team logo instead of a headshot.
  if (/^[A-Z]{2,3}$/.test(playerId)) return `${SLEEPER_CDN_BASE}/images/team_logos/nfl/${playerId.toLowerCase()}.png`;
  return `${SLEEPER_CDN_BASE}/content/nfl/players/thumb/${playerId}.jpg`;
}
