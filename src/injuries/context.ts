import type { Player } from "../sleeper/types.js";
import { normalizeName, playerFullName, type PlayerStore } from "../sleeper/players.js";
import { designation, type InjuryFeed, type InjuryFeedResult, type InjuryItem } from "./espn.js";

export interface InjuryEvidence {
  source: "sleeper" | "espn";
  designation: string | null;
  reported_at: string | null;
  retrieved_at: string | null;
  cache_expires_at: string | null;
  stale: boolean;
  body_part: string | null;
  note: string | null;
  url: string | null;
}

export interface PlayerInjuryContext {
  designation: string | null;
  source: "sleeper" | "espn" | "conflict";
  conflict: boolean;
  needs_check: boolean;
  reasons: string[];
  espn_match: "disabled" | "matched" | "not_listed" | "ambiguous" | "unavailable";
  reports: InjuryEvidence[];
}

export interface InjuryReport {
  source_status: "disabled" | "available" | "stale" | "unavailable";
  warning: string | null;
  feed_updated_at: string | null;
  byPlayer: Map<string, PlayerInjuryContext>;
}

const iso = (n: number) => new Date(n).toISOString();
const key = (name: string, team: string | null, position: string | null) => `${normalizeName(name)}|${team}|${position}`;

/** Exact ID plus corroborating identity, or a unique name/team/position match. Never fuzzy. */
export function matchInjuries(items: InjuryItem[], players: Player[]): { matched: Map<string, InjuryItem>; ambiguous: Set<string> } {
  const byEspn = new Map<string, Player[]>(), byIdentity = new Map<string, Player[]>();
  for (const player of players) {
    if (player.espn_id != null) {
      const id = String(player.espn_id);
      byEspn.set(id, [...(byEspn.get(id) ?? []), player]);
    }
    if (player.team && player.position) {
      const id = key(playerFullName(player), player.team, player.position);
      byIdentity.set(id, [...(byIdentity.get(id) ?? []), player]);
    }
  }
  const matched = new Map<string, InjuryItem>(), ambiguous = new Set<string>();
  for (const item of items) {
    if (!item.team || !item.position) continue;
    const identity = key(item.name, item.team, item.position);
    const direct = item.athleteId ? byEspn.get(item.athleteId) ?? [] : [];
    const candidates = direct.length ? direct : byIdentity.get(identity) ?? [];
    if (candidates.length !== 1 || key(playerFullName(candidates[0]!), candidates[0]!.team, candidates[0]!.position) !== identity) {
      for (const player of [...candidates, ...(byIdentity.get(identity) ?? [])]) ambiguous.add(player.player_id);
      continue;
    }
    const id = candidates[0]!.player_id, previous = matched.get(id);
    if (!previous) matched.set(id, item);
    else if (previous.designation !== item.designation && (!previous.reportedAt || !item.reportedAt || previous.reportedAt === item.reportedAt)) ambiguous.add(id);
    else if (item.reportedAt && (!previous.reportedAt || item.reportedAt > previous.reportedAt)) matched.set(id, item);
  }
  for (const id of ambiguous) matched.delete(id);
  return { matched, ambiguous };
}

export class InjuryContextService {
  constructor(private readonly players: PlayerStore, private readonly feed: InjuryFeed | null, private readonly now: () => number = Date.now) {}

  async report(ids: readonly string[]): Promise<InjuryReport> {
    await this.players.ensureLoaded();
    let result: InjuryFeedResult | null = null;
    if (this.feed) {
      try { result = await this.feed.get(); }
      catch { result = { snapshot: null, error: "The optional injury source is unavailable; showing Sleeper data." }; }
    }
    const snapshot = result?.snapshot ?? null;
    const stale = snapshot ? this.now() >= snapshot.expiresAt : false;
    const sourceStatus = !this.feed ? "disabled" : !snapshot ? "unavailable" : stale ? "stale" : "available";
    const index = matchInjuries(snapshot?.items ?? [], this.players.all());
    const byPlayer = new Map<string, PlayerInjuryContext>();
    for (const id of ids) {
      const player = this.players.raw(id);
      if (!player) continue;
      const freshness = this.players.freshness;
      const sleeper: InjuryEvidence = {
        source: "sleeper", designation: designation(player.injury_status),
        reported_at: null, // news_updated is not an injury-update timestamp.
        retrieved_at: freshness.retrieved_at, cache_expires_at: freshness.cache_expires_at, stale: freshness.stale,
        body_part: player.injury_body_part ?? null, note: player.injury_notes ?? null,
        url: "https://api.sleeper.app/v1/players/nfl",
      };
      const item = index.matched.get(id);
      const espn: InjuryEvidence | null = item && snapshot ? {
        source: "espn", designation: item.designation, reported_at: item.reportedAt,
        retrieved_at: iso(snapshot.retrievedAt), cache_expires_at: iso(snapshot.expiresAt), stale,
        body_part: item.bodyPart, note: item.note, url: item.url,
      } : null;
      // A missing Sleeper flag is not evidence of health; an explicit ESPN flag adds context.
      // When a Sleeper flag conflicts with ESPN (including Active), keep both, choose neither.
      const conflict = Boolean(espn && sleeper.designation !== null && espn.designation !== sleeper.designation);
      const selected = espn && !espn.stale ? espn : sleeper;
      const reasons: string[] = [];
      if (conflict) reasons.push("Sources disagree; confirm the current designation.");
      if (/^(questionable|doubtful)$/i.test(selected.designation ?? "")) reasons.push(`${selected.designation}: check availability before kickoff; not an automatic bench recommendation.`);
      if (sleeper.stale || espn?.stale) reasons.push("A source snapshot is stale; its fetch time has not been refreshed.");
      if (index.ambiguous.has(id)) reasons.push("The external player identity or reports are ambiguous; no match was assumed.");
      if (espn && !espn.reported_at) reasons.push("ESPN did not provide a valid report timestamp.");
      if (espn?.designation && sleeper.designation === null) reasons.push("ESPN reports an injury that is not flagged in the Sleeper snapshot; review it before lineup changes.");
      const known = /^(questionable|doubtful|out|ir|pup|sus|na|nfi|dnr|cov)$/i;
      if (selected.designation && !known.test(selected.designation)) reasons.push("Unrecognized injury designation; confirm its meaning.");
      byPlayer.set(id, {
        designation: conflict ? null : selected.designation, source: conflict ? "conflict" : selected.source,
        conflict, needs_check: reasons.length > 0, reasons,
        espn_match: !this.feed ? "disabled" : !snapshot ? "unavailable" : index.ambiguous.has(id) ? "ambiguous" : item ? "matched" : "not_listed",
        reports: espn ? [sleeper, espn] : [sleeper],
      });
    }
    return {
      source_status: sourceStatus,
      warning: result?.error ?? (stale ? "Using a stale ESPN snapshot." : null),
      feed_updated_at: snapshot?.feedUpdatedAt ?? null,
      byPlayer,
    };
  }
}

export function injuryMetadata(report: InjuryReport) {
  return {
    optional_source: "espn",
    status: report.source_status,
    warning: report.warning,
    feed_updated_at: report.feed_updated_at,
    note: "Retrieval time is not the injury report time. A missing designation or absence from the feed is not medical clearance. Projection and odds models still use Sleeper data.",
  };
}
