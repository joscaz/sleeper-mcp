import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError, type ServerContext } from "../context.js";
import { TTL } from "../sleeper/client.js";
import { TEAM_NAMES } from "../sleeper/players.js";
import { parseUsageRows, playerUsageWeeks, teamTotals, usageTrend, usageWindow, type UsageWeek } from "../usage.js";
import { guard, seasonSchema } from "./shared.js";

const windowShape = {
  season: seasonSchema.describe("Regular-season year. Defaults to the current NFL season, not a league's draft year."),
  weeks: z.number().int().min(1).max(8).default(4).describe("Calendar-week lookback, 1–8 (default 4). Byes/missing weeks do not extend it."),
  end_week: z.number().int().min(1).max(18).optional().describe("Last week of the window. Default: latest fully completed week before the current week."),
};
interface WindowArgs { season?: string | number; weeks: number; end_week?: number }

async function loadUsage(ctx: ServerContext, args: WindowArgs) {
  const state = await ctx.client.getNflState();
  const season = args.season === undefined ? state.season : String(args.season).trim();
  // Reject malformed input before placing it in an upstream request.
  if (!/^\d{4}$/.test(season) || Number(season) < 2009 || Number(season) > Number(state.season)) {
    throw new ToolError("Choose a regular-season year from 2009 through the current NFL season.");
  }
  const schedule = await ctx.client.getSchedule("nfl", "regular", season);
  const selected = usageWindow(state, schedule, season, args.weeks, args.end_week);
  const weeks: UsageWeek[] = await Promise.all(selected.map(async week => {
    const games = schedule.filter(g => g.week === week);
    const base = { week, games, rows: [] };
    if (!games.length) return { ...base, status: "missing_data", reason: "No schedule entries for this week." };
    if (games.some(g => g.status !== "complete")) {
      return { ...base, status: "not_completed", reason: "At least one game is not complete; partial-week usage is excluded." };
    }
    try {
      const rows = parseUsageRows(await ctx.client.getUsageStats(season, week), season, week, games);
      return { ...base, rows, status: rows.length ? "available" : "missing_data",
        reason: rows.length ? null : "No weekly stat rows returned." };
    } catch (error) {
      return { ...base, status: "missing_data",
        reason: error instanceof ToolError ? error.message : "Weekly stats could not be retrieved; retry later." };
    }
  }));
  return { season, weeks };
}

function metadata(season: string, weeks: UsageWeek[]) {
  return {
    read_only: true, season, season_type: "regular",
    source: "Sleeper weekly stat rows (undocumented public endpoint)",
    collected_at: new Date().toISOString(),
    cache_ttl_seconds: TTL.stats / 1000,
    coverage: weeks.map(w => {
      const times = w.rows.flatMap(r => r.updated_at === null ? [] : [r.updated_at]);
      return {
        week: w.week, status: w.status, reason: w.reason, row_count: w.rows.length,
        upstream_updated_at_range: times.length ? {
          oldest: new Date(Math.min(...times)).toISOString(), newest: new Date(Math.max(...times)).toISOString(),
        } : null,
      };
    }),
    methodology: [
      "QB/RB/WR/TE fantasy-position rows only (includes fullbacks eligible at RB). Counts are sparse: omitted counts on positive-offensive-snap rows are treated as zero; explicit null/malformed counts invalidate the week.",
      "Snap share uses that player's reported tm_off_snp. Other shares use summed returned rows for that week's team, not independently verified full-team totals. Zero/unknown denominators produce null.",
      "A teammate's volume without snap counts makes team-volume shares uncertain, but known player counts and snap share remain visible. Each metric reports its own sample count.",
      "Air yards can be negative; air-yard shares are not capped at 0–100.",
      "Trends compare the last two played weeks with earlier played weeks in the window; with two, compare last versus first. Equal-weight weekly means, per-metric sample counts; fewer than two played weeks cannot establish a trend.",
      "Byes, no-offensive-snap rows, missing data and unfinished games are excluded from trend means, not scored as zero. Inferred byes require matching surrounding historical team rows; other missing rows stay unknown.",
      "Historical team comes from the weekly row, never today's player team. Player trends may span a trade; team usage excludes other-team weeks.",
      "collected_at is response assembly time, not the source update time. Stats may be cached for five minutes and revised by Sleeper later. No breakout labels, prediction, injury diagnosis or lineup changes.",
    ],
    warning: !weeks.length ? "No completed regular-season weeks are available in the requested window."
      : weeks.every(w => w.status !== "available") ? "No usable weekly stats were returned; see coverage for each week's reason." : null,
  };
}

export function registerUsageTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool("get_player_trends", {
    title: "Player usage trends",
    description: "Read-only weekly offensive snaps, targets, carries, red-zone usage and team shares for up to 20 QB/RB/WR/TE players. Completed regular-season weeks only, with sample counts and numerical changes, not breakout scores. Use search_players to resolve IDs.",
    inputSchema: {
      ...windowShape,
      player_ids: z.array(z.string().trim().min(1)).min(1).max(20).describe("Sleeper player IDs; resolve names with search_players."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async args => guard(async () => {
    await ctx.players.ensureLoaded();
    const ids = [...new Set(args.player_ids)];
    for (const id of ids) {
      const p = ctx.players.raw(id);
      if (!p) throw new ToolError(`Unknown player ID ${id}; use search_players first.`);
      if (!(p.fantasy_positions ?? [p.position]).some(pos => ["QB", "RB", "WR", "TE"].includes(pos ?? ""))) {
        throw new ToolError(`${ctx.players.ref(id).name}: usage trends cover QB/RB/WR/TE, not kickers, defenses or IDP-only players.`);
      }
    }
    const { season, weeks } = await loadUsage(ctx, args);
    return {
      ...metadata(season, weeks),
      players: ids.map(id => {
        const ref = ctx.players.ref(id);
        const history = playerUsageWeeks(weeks, id);
        return { player: { id, name: ref.name, pos: ref.pos, current_team: ref.team }, weeks: history, trend: usageTrend(history) };
      }),
    };
  }));

  server.registerTool("get_team_usage", {
    title: "NFL team offensive usage",
    description: "Read-only distribution of an NFL team's offensive snaps, targets, carries, red-zone usage and team shares over completed regular-season weeks. Uses historical team assignments, reports denominator coverage and includes players with no offensive snaps reported.",
    inputSchema: {
      ...windowShape,
      team: z.string().trim().toUpperCase().min(2).max(3).describe("NFL team code, e.g. BAL, KC, WAS (WSH accepted). Not a fantasy team name."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async args => guard(async () => {
    const team = args.team === "WSH" ? "WAS" : args.team;
    if (!Object.hasOwn(TEAM_NAMES, team)) throw new ToolError("Unknown NFL team code; use an abbreviation such as BAL, KC or WAS.");
    await ctx.players.ensureLoaded();
    const { season, weeks } = await loadUsage(ctx, args);
    const ids = [...new Set(weeks.flatMap(w => w.rows.filter(r => r.team === team).map(r => r.player_id)))];
    return {
      ...metadata(season, weeks), team, team_name: TEAM_NAMES[team],
      team_weeks: weeks.map(w => {
        const totals = teamTotals(w, team);
        const bye = w.games.length > 0 && !w.games.some(g => g.home === team || g.away === team);
        return {
          week: w.week, status: bye ? "bye" : w.status !== "available" ? w.status : totals.usable ? "available" : "missing_data",
          denominator: "Returned QB/RB/WR/TE rows assigned to this team that week", ...totals,
        };
      }),
      players: ids.map(id => {
        const lastRow = weeks.flatMap(w => w.rows).findLast(r => r.player_id === id)!;
        const ref = ctx.players.raw(id) ? ctx.players.ref(id) : null;
        const history = playerUsageWeeks(weeks, id, team);
        return {
          player: { id, name: ref?.name ?? lastRow.name ?? `Unknown player (${id})`, pos: ref?.pos ?? lastRow.position },
          weeks: history, trend: usageTrend(history),
        };
      }).sort((a, b) => a.player.name.localeCompare(b.player.name)),
    };
  }));
}
