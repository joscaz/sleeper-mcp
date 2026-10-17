/** Optional, read-only ESPN injury feed. No account data or credentials are sent. */
export const ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
export const DEFAULT_INJURY_CACHE_MS = 5 * 60_000;

export interface InjuryItem {
  athleteId: string | null;
  name: string;
  team: string | null;
  position: string | null;
  designation: string | null;
  reportedAt: string | null;
  bodyPart: string | null;
  note: string | null;
  url: string | null;
}

export interface InjurySnapshot {
  items: InjuryItem[];
  retrievedAt: number;
  feedUpdatedAt: string | null;
  expiresAt: number;
}

export interface InjuryFeedResult {
  snapshot: InjurySnapshot | null;
  error: string | null;
}

export interface InjuryFeed {
  get(): Promise<InjuryFeedResult>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;

export function timestamp(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function designation(value: unknown): string | null {
  const text = str(value);
  if (!text || /^(active|healthy|none)$/i.test(text)) return null;
  const known: Record<string, string> = { questionable: "Questionable", doubtful: "Doubtful", out: "Out", ir: "IR", "injured reserve": "IR", pup: "PUP", suspended: "Sus", sus: "Sus" };
  return known[text.toLowerCase()] ?? text;
}

function playerLink(value: unknown): { id: string; url: string } | null {
  if (!Array.isArray(value)) return null;
  for (const link of value) {
    try {
      const url = new URL(String(obj(link).href));
      const id = /\/nfl\/player\/(?:[^/]+\/)*_\/id\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
      if (url.protocol === "https:" && !url.username && !url.password && /^(www\.)?espn\.com$/.test(url.hostname) && id) return { id, url: url.href };
    } catch { /* Ignore malformed and non-web links. */ }
  }
  return null;
}

/** Reject broken root shapes rather than interpreting an error page as an empty, healthy report. */
export function parseInjuries(body: unknown): { items: InjuryItem[]; feedUpdatedAt: string | null } {
  const root = obj(body);
  if (!Array.isArray(root.injuries) || (root.status !== undefined && root.status !== "success")) {
    throw new Error("Unexpected ESPN injury response.");
  }
  const items: InjuryItem[] = [];
  for (const group of root.injuries) {
    const rows = obj(group).injuries;
    if (!Array.isArray(rows)) throw new Error("Unexpected ESPN team injury response.");
    for (const row of rows) {
      const item = obj(row), athlete = obj(item.athlete);
      const name = str(athlete.displayName);
      if (!name || !str(item.status)) throw new Error("Unexpected ESPN player injury response.");
      const link = playerLink(athlete.links);
      const team = str(obj(athlete.team).abbreviation)?.toUpperCase() ?? null;
      items.push({
        athleteId: link?.id ?? null,
        name,
        team: team === "WSH" ? "WAS" : team,
        position: str(obj(athlete.position).abbreviation)?.toUpperCase() ?? null,
        designation: designation(item.status),
        reportedAt: timestamp(item.date),
        bodyPart: str(obj(item.details).type),
        note: str(item.shortComment)?.slice(0, 1200) ?? null,
        url: link?.url ?? null,
      });
    }
  }
  return { items, feedUpdatedAt: timestamp(root.timestamp) };
}

/** One shared request per cache window; errors retain the original snapshot time and back off. */
export class EspnInjuryFeed implements InjuryFeed {
  private snapshot: InjurySnapshot | null = null;
  private pending: Promise<InjuryFeedResult> | null = null;
  private error: string | null = null;
  private retryAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(options: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_INJURY_CACHE_MS;
    this.timeoutMs = options.timeoutMs ?? 8000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("Injury cache duration must be positive.");
  }

  async get(): Promise<InjuryFeedResult> {
    if (this.pending) return this.pending;
    if ((this.snapshot && this.now() < this.snapshot.expiresAt) || this.now() < this.retryAt) {
      return { snapshot: this.snapshot, error: this.error };
    }
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async load(): Promise<InjuryFeedResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.retryAt = this.now() + this.ttlMs;
    try {
      const response = await this.fetchImpl(ESPN_INJURIES_URL, { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) {
        const seconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(seconds) && seconds > 0) this.retryAt = Math.max(this.retryAt, this.now() + seconds * 1000);
        throw new Error(`ESPN injury feed returned HTTP ${response.status}.`);
      }
      const parsed = parseInjuries(await response.json());
      const retrievedAt = this.now();
      this.snapshot = { ...parsed, retrievedAt, expiresAt: retrievedAt + this.ttlMs };
      this.error = null;
    } catch (err) {
      // Never include arbitrary upstream response bodies or headers in tool output.
      this.error = err instanceof Error && /^Unexpected ESPN|^ESPN injury feed returned HTTP/.test(err.message)
        ? err.message : "ESPN injury feed is unavailable or timed out.";
    } finally {
      clearTimeout(timer);
    }
    return { snapshot: this.snapshot, error: this.error };
  }
}
