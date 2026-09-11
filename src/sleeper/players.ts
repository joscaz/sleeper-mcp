import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SleeperClient } from "./client.js";
import type { Player, PlayerMap, Sport } from "./types.js";

/** Compact, model-friendly view of a player. Short keys on purpose: these appear hundreds of times per response. */
export interface PlayerRef {
  id: string;
  name: string;
  pos: string | null;
  team: string | null;
  /** Injury designation when present (Questionable, Doubtful, Out, IR, PUP, Sus, ...). */
  inj?: string;
}

export interface PlayerSearchOptions {
  position?: string;
  team?: string;
  activeOnly?: boolean;
  limit?: number;
}

export interface PlayerStoreOptions {
  sport?: Sport;
  /** Directory for the on-disk copy of the player map. Set to null to disable disk caching. */
  cacheDir?: string | null;
  maxAgeMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const DEFAULT_MAX_AGE = 24 * 60 * 60_000;
const TEAM_DEFENSE_RE = /^[A-Z]{2,3}$/;

const TEAM_NAMES: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SF: "San Francisco 49ers",
  SEA: "Seattle Seahawks", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
  OAK: "Oakland Raiders", SD: "San Diego Chargers", STL: "St. Louis Rams",
};

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "sleeper-mcp");
}

export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function playerFullName(player: Player): string {
  if (player.full_name) return player.full_name;
  const first = player.first_name ?? "";
  const last = player.last_name ?? "";
  const name = `${first} ${last}`.trim();
  if (name) return name;
  return TEAM_NAMES[player.player_id] ?? player.player_id;
}

/**
 * Loads, caches (memory + disk) and indexes Sleeper's player map so that roster/matchup/transaction
 * payloads can carry names instead of opaque IDs.
 */
export class PlayerStore {
  private players: PlayerMap | null = null;
  private loadedAt = 0;
  private loading: Promise<PlayerMap> | null = null;
  private index: { id: string; full: string; last: string; rank: number }[] = [];

  private readonly sport: Sport;
  private readonly cacheDir: string | null;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly client: SleeperClient,
    options: PlayerStoreOptions = {},
  ) {
    this.sport = options.sport ?? "nfl";
    this.cacheDir = options.cacheDir === undefined ? defaultCacheDir() : options.cacheDir;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  get isLoaded(): boolean {
    return this.players !== null;
  }

  get count(): number {
    return this.players ? Object.keys(this.players).length : 0;
  }

  get lastLoadedAt(): number {
    return this.loadedAt;
  }

  /** Ensure the player map is available (memory -> disk -> network). Safe to call repeatedly. */
  async ensureLoaded(): Promise<PlayerMap> {
    if (this.players && this.now() - this.loadedAt < this.maxAgeMs) return this.players;
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Force a fresh download, bypassing memory and disk caches. */
  async refresh(): Promise<PlayerMap> {
    const map = await this.client.getAllPlayers(this.sport);
    this.client.cache.delete(`GET /players/${this.sport}`);
    await this.adopt(map, this.now(), true);
    return map;
  }

  private async load(): Promise<PlayerMap> {
    const fromDisk = await this.readDisk();
    if (fromDisk && this.now() - fromDisk.savedAt < this.maxAgeMs) {
      await this.adopt(fromDisk.players, fromDisk.savedAt, false);
      this.log(`player map loaded from disk cache (${this.count} players)`);
      return fromDisk.players;
    }
    try {
      const map = await this.client.getAllPlayers(this.sport);
      await this.adopt(map, this.now(), true);
      this.log(`player map downloaded (${this.count} players)`);
      return map;
    } catch (err) {
      if (fromDisk) {
        // Stale is better than nothing.
        await this.adopt(fromDisk.players, fromDisk.savedAt, false);
        this.log(`player map download failed (${(err as Error).message}); using stale disk cache`);
        return fromDisk.players;
      }
      throw err;
    }
  }

  private async adopt(map: PlayerMap, savedAt: number, persist: boolean): Promise<void> {
    this.players = map;
    this.loadedAt = savedAt;
    this.buildIndex(map);
    if (persist) await this.writeDisk(map, savedAt);
  }

  private buildIndex(map: PlayerMap): void {
    const index: typeof this.index = [];
    for (const [id, p] of Object.entries(map)) {
      if (!p) continue;
      const full = normalizeName(p.search_full_name ?? playerFullName(p));
      const last = normalizeName(p.last_name ?? "");
      index.push({ id, full, last, rank: typeof p.search_rank === "number" ? p.search_rank : Number.MAX_SAFE_INTEGER });
    }
    index.sort((a, b) => a.rank - b.rank);
    this.index = index;
  }

  private diskPath(): string | null {
    return this.cacheDir ? path.join(this.cacheDir, `players-${this.sport}.json`) : null;
  }

  private async readDisk(): Promise<{ players: PlayerMap; savedAt: number } | null> {
    const file = this.diskPath();
    if (!file) return null;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { savedAt?: number; players?: PlayerMap };
      if (!parsed.players || typeof parsed.savedAt !== "number") return null;
      return { players: parsed.players, savedAt: parsed.savedAt };
    } catch {
      return null;
    }
  }

  private async writeDisk(map: PlayerMap, savedAt: number): Promise<void> {
    const file = this.diskPath();
    if (!file) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ savedAt, players: map }));
      await fs.rename(tmp, file);
    } catch (err) {
      this.log(`could not persist player cache to ${file}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Lookups (synchronous; call ensureLoaded() first)
  // ---------------------------------------------------------------------------

  raw(id: string): Player | undefined {
    return this.players?.[id] ?? undefined;
  }

  /** Compact reference for a player id. Unknown ids degrade to the id itself so nothing is lost. */
  ref(id: string, extra?: Partial<PlayerRef>): PlayerRef {
    const p = this.players?.[id];
    if (!p) {
      const teamName = TEAM_NAMES[id];
      return { id, name: teamName ?? id, pos: teamName ? "DEF" : null, team: teamName ? id : null, ...extra };
    }
    const ref: PlayerRef = {
      id,
      name: playerFullName(p),
      pos: p.position ?? p.fantasy_positions?.[0] ?? (TEAM_DEFENSE_RE.test(id) ? "DEF" : null),
      team: p.team ?? (TEAM_DEFENSE_RE.test(id) ? id : null),
    };
    if (p.injury_status) ref.inj = p.injury_status;
    return { ...ref, ...extra };
  }

  refs(ids: readonly string[] | null | undefined): PlayerRef[] {
    return (ids ?? []).filter((id) => id && id !== "0").map((id) => this.ref(id));
  }

  /** One-line label, e.g. "Josh Allen (QB, BUF)". */
  label(id: string): string {
    const r = this.ref(id);
    const meta = [r.pos, r.team].filter(Boolean).join(", ");
    return meta ? `${r.name} (${meta})` : r.name;
  }

  /** Fuzzy-ish name search: exact > prefix > substring, then Sleeper's search_rank. */
  search(query: string, options: PlayerSearchOptions = {}): Player[] {
    if (!this.players) return [];
    const q = normalizeName(query);
    const limit = options.limit ?? 10;
    const position = options.position?.toUpperCase();
    const team = options.team?.toUpperCase();
    const activeOnly = options.activeOnly ?? false;

    const scored: { p: Player; score: number; rank: number }[] = [];
    for (const entry of this.index) {
      const p = this.players[entry.id];
      if (!p) continue;
      let score = 0;
      if (q.length > 0) {
        if (entry.full === q || entry.last === q) score = 3;
        else if (entry.full.startsWith(q) || entry.last.startsWith(q)) score = 2;
        else if (entry.full.includes(q)) score = 1;
        else if (TEAM_DEFENSE_RE.test(entry.id) && normalizeName(TEAM_NAMES[entry.id] ?? "").includes(q)) score = 1;
        if (score === 0) continue;
      }
      if (position && !(p.position === position || p.fantasy_positions?.includes(position))) continue;
      if (team && p.team !== team) continue;
      if (activeOnly && !isActive(p)) continue;
      scored.push({ p, score, rank: entry.rank });
    }
    scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
    return scored.slice(0, limit).map((s) => s.p);
  }

  /** Iterate all players (for free-agent scans etc.). */
  all(): Player[] {
    return this.players ? Object.values(this.players).filter((p): p is Player => Boolean(p)) : [];
  }
}

export function isActive(p: Player): boolean {
  if (p.active === false) return false;
  if (p.status && /inactive|retired/i.test(p.status)) return false;
  return Boolean(p.team) || TEAM_DEFENSE_RE.test(p.player_id);
}

export function isTeamDefense(id: string): boolean {
  return TEAM_DEFENSE_RE.test(id);
}

export { TEAM_NAMES };
