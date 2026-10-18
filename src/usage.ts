import { ToolError } from "./context.js";
import { TEAM_NAMES } from "./sleeper/players.js";
import type { NflState, ScheduleGame } from "./sleeper/types.js";

// Descriptive measurements, not predictive scores or threshold-based role labels.
export const COUNT_KEYS = ["off_snp", "rec_tgt", "rush_att", "rec_rz_tgt", "rush_rz_att", "rec_air_yd"] as const;
export const SHARE_KEYS = ["snap_share", "target_share", "carry_share", "red_zone_share", "air_yard_share"] as const;
type CountKey = (typeof COUNT_KEYS)[number];
type ShareKey = (typeof SHARE_KEYS)[number];
type Metrics = Record<CountKey | ShareKey, number | null>;
const VALIDATED_KEYS = [...COUNT_KEYS, "tm_off_snp", "gms_active", "gp", "st_snp"];

export interface UsageRow {
  player_id: string;
  team: string;
  game_id: string;
  stats: Record<string, number | undefined>;
  name: string | null;
  position: string | null;
  updated_at: number | null;
}

export interface UsageWeek {
  week: number;
  games: ScheduleGame[];
  rows: UsageRow[];
  status: "available" | "missing_data" | "not_completed";
  reason: string | null;
}

/** Reject a malformed week rather than silently turn lost/duplicated rows into team volume. */
export function parseUsageRows(value: unknown, season: string, week: number, games: ScheduleGame[]): UsageRow[] {
  if (!Array.isArray(value)) throw new ToolError("Weekly stat rows are missing or malformed.");
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    const row = object(raw);
    const stats = object(row?.stats);
    if (!row || !stats || typeof row.player_id !== "string" || !row.player_id ||
        typeof row.team !== "string" || !Object.hasOwn(TEAM_NAMES, row.team) ||
        String(row.season) !== season || row.week !== week || row.season_type !== "regular" ||
        row.sport !== "nfl" || typeof row.game_id !== "string" ||
        !games.some(g => g.game_id === row.game_id && (g.home === row.team || g.away === row.team))) {
      throw new ToolError("Weekly stat row has missing or inconsistent player, season, team or game metadata.");
    }
    if (ids.has(row.player_id)) throw new ToolError("Duplicate player rows; weekly team totals cannot be trusted.");
    ids.add(row.player_id);
    for (const key of VALIDATED_KEYS) {
      const n = stats[key];
      if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || (key !== "rec_air_yd" && n < 0))) {
        throw new ToolError(`Weekly stat row has an invalid ${key} value.`);
      }
    }
    const player = object(row.player);
    const name = [player?.first_name, player?.last_name].filter(v => typeof v === "string" && v.trim()).join(" ");
    return {
      player_id: row.player_id, team: row.team, game_id: row.game_id,
      stats: stats as UsageRow["stats"], name: name || null,
      position: typeof player?.position === "string" ? player.position : null,
      updated_at: typeof row.updated_at === "number" && Number.isFinite(row.updated_at) && row.updated_at > 0 &&
        !Number.isNaN(new Date(row.updated_at).getTime()) ? row.updated_at : null,
    };
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Calendar-week window ending before the current regular-season week, never live partial games. */
export function usageWindow(state: NflState, schedule: ScheduleGame[], season: string, count: number, endWeek?: number): number[] {
  const year = Number(season);
  if (!/^\d{4}$/.test(season) || year < 2009 || year > Number(state.season)) {
    throw new ToolError("Choose a regular-season year from 2009 through the current NFL season.");
  }
  const seasonLength = year < 2021 ? 17 : 18;
  let ceiling = seasonLength;
  if (season === state.season) {
    if (state.season_type === "regular") ceiling = Math.min(seasonLength, state.week - 1);
    else if (state.season_type !== "post" && state.season_type !== "off") ceiling = 0;
  }
  if (endWeek !== undefined && endWeek > ceiling) {
    throw new ToolError("end_week must be a past regular-season week, not the current or a future week.");
  }
  if (ceiling < 1) return [];
  if (!schedule.length) throw new ToolError("Season schedule is unavailable; cannot verify completed weeks.");
  const completed = schedule.filter(g => g.week <= ceiling && g.week >= 1).map(g => g.week)
    .filter(week => schedule.filter(g => g.week === week).every(g => g.status === "complete"));
  const last = endWeek ?? Math.max(0, ...completed);
  return Array.from({ length: Math.min(count, last) }, (_, i) => last - Math.min(count, last) + i + 1);
}

function emptyMetrics(): Metrics {
  return Object.fromEntries([...COUNT_KEYS, ...SHARE_KEYS].map(k => [k, null])) as Metrics;
}

/** Sparse count fields are zero only on rows with a positive offensive snap count. */
function count(row: UsageRow, key: CountKey): number | null {
  return row.stats[key] ?? ((row.stats.off_snp ?? 0) > 0 ? 0 : null);
}

function percent(value: number | null, total: number | null): number | null {
  return value !== null && total !== null && total > 0 ? value / total * 100 : null;
}

export function teamTotals(week: UsageWeek, team: string) {
  const rows = week.rows.filter(r => r.team === team);
  const hasSnaps = rows.some(r => (r.stats.off_snp ?? 0) > 0);
  // Volume without snaps is a partial feed, not a zero-snap performance.
  const inconsistent = rows.some(r => (r.stats.off_snp ?? 0) <= 0 &&
    COUNT_KEYS.some(k => k !== "off_snp" && (r.stats[k] ?? 0) !== 0));
  const usable = week.status === "available" && hasSnaps && !inconsistent;
  const sum = (key: CountKey) => usable ? rows.reduce((total, r) => total + (r.stats[key] ?? 0), 0) : null;
  const targets = sum("rec_tgt");
  const carries = sum("rush_att");
  const rzTargets = sum("rec_rz_tgt");
  const rzCarries = sum("rush_rz_att");
  return {
    row_count: rows.length,
    rows_with_offensive_snaps: rows.filter(r => (r.stats.off_snp ?? 0) > 0).length,
    usable,
    targets, carries,
    red_zone_opportunities: rzTargets !== null && rzCarries !== null ? rzTargets + rzCarries : null,
    air_yards: sum("rec_air_yd"),
  };
}

export interface PlayerUsageWeek {
  week: number;
  team: string | null;
  team_basis: "stat_row" | "surrounding_stat_rows" | "unknown";
  status: "played" | "no_offensive_snaps_reported" | "inferred_bye" | "missing_data" | "not_completed" | "other_team";
  reason: string | null;
  metrics: Metrics;
  denominators: (ReturnType<typeof teamTotals> & { team_offensive_snaps: number | null }) | null;
}

export function playerUsageWeeks(weeks: UsageWeek[], playerId: string, onlyTeam?: string): PlayerUsageWeek[] {
  return weeks.map((week, index) => {
    const row = week.rows.find(r => r.player_id === playerId);
    const base: PlayerUsageWeek = {
      week: week.week, team: row?.team ?? null, team_basis: row ? "stat_row" : "unknown",
      status: "missing_data", reason: null, metrics: emptyMetrics(), denominators: null,
    };
    if (week.status !== "available") return { ...base, status: week.status, reason: week.reason };
    if (row && onlyTeam && row.team !== onlyTeam) return { ...base, status: "other_team" };
    if (!row) {
      // Never use today's team for a historical bye. A bracketed inference is explicitly labeled:
      // even matching surrounding rows cannot rule out an unobserved intervening roster move.
      const before = weeks.slice(0, index).reverse().flatMap(w => w.rows).find(r => r.player_id === playerId);
      const after = weeks.slice(index + 1).flatMap(w => w.rows).find(r => r.player_id === playerId);
      if (before && after && before.team === after.team && (!onlyTeam || before.team === onlyTeam) &&
          !week.games.some(g => g.home === before.team || g.away === before.team)) {
        return { ...base, team: before.team, team_basis: "surrounding_stat_rows", status: "inferred_bye",
          reason: "No scheduled team game; matching surrounding stat-row teams suggest a bye, not verified roster history." };
      }
      return { ...base, reason: "No player row. Absence alone cannot establish a bye, injury or missed game." };
    }
    const totals = teamTotals(week, row.team);
    base.denominators = { ...totals, team_offensive_snaps: row.stats.tm_off_snp ?? null };
    if (!totals.usable) return { ...base, reason: "Team offensive usage is missing or incomplete." };
    if ((row.stats.off_snp ?? 0) <= 0) {
      return { ...base, status: "no_offensive_snaps_reported",
        reason: "A player row exists but reports no offensive snaps. This is not proof of injury or inactivity." };
    }
    const metrics = emptyMetrics();
    for (const key of COUNT_KEYS) metrics[key] = count(row, key);
    const teamSnaps = row.stats.tm_off_snp ?? null;
    metrics.snap_share = teamSnaps !== null && row.stats.off_snp! <= teamSnaps ? percent(metrics.off_snp, teamSnaps) : null;
    metrics.target_share = percent(metrics.rec_tgt, totals.targets);
    metrics.carry_share = percent(metrics.rush_att, totals.carries);
    metrics.red_zone_share = percent(metrics.rec_rz_tgt! + metrics.rush_rz_att!, totals.red_zone_opportunities);
    metrics.air_yard_share = percent(metrics.rec_air_yd, totals.air_yards);
    return { ...base, status: "played", metrics };
  });
}

/** Equal-weight weekly means. Do not substitute zero for a missing measurement. */
export function usageTrend(weeks: PlayerUsageWeek[]) {
  const played = weeks.filter(w => w.status === "played");
  const split = played.length === 2 ? 1 : Math.max(0, played.length - 2);
  const baseline = played.slice(0, split);
  const recent = played.slice(split);
  const sample = (group: PlayerUsageWeek[], key: keyof Metrics) => {
    const values = group.map(w => w.metrics[key]).filter((n): n is number => n !== null);
    return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, samples: values.length };
  };
  const metrics = Object.fromEntries([...COUNT_KEYS, ...SHARE_KEYS].map(key => {
    const a = sample(baseline, key), b = sample(recent, key);
    return [key, {
      baseline: a, recent: b,
      delta: a.mean !== null && b.mean !== null ? b.mean - a.mean : null,
      delta_unit: (SHARE_KEYS as readonly string[]).includes(key) ? "percentage_points" : "per_played_week",
    }];
  }));
  return {
    played_weeks: played.length,
    baseline_weeks: baseline.map(w => w.week),
    recent_weeks: recent.map(w => w.week),
    status: played.length < 2 ? "insufficient_sample" : "descriptive_only",
    teams: [...new Set(played.map(w => w.team))],
    metrics,
  };
}
