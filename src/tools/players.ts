import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, ToolError, type ServerContext } from "../context.js";
import { playerHeadshotUrl } from "../sleeper/client.js";
import { isActive, isTeamDefense, playerFullName } from "../sleeper/players.js";
import type { Player } from "../sleeper/types.js";
import { isoDate } from "../format.js";
import { guard, leagueIdSchema, positionSchema, sportSchema } from "./shared.js";

export function registerPlayerTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "search_players",
    {
      title: "Search players",
      description:
        "Find NFL players (and team defenses) by name, optionally filtered by position and NFL team. Returns player_id, position, team, injury status, age, experience and depth-chart slot. Use the player_id with other tools.",
      inputSchema: {
        query: z.string().trim().default("").describe("Name or partial name (e.g. 'mahomes', 'ja marr', 'lions'). Leave empty to list by position/team."),
        position: positionSchema,
        team: z.string().trim().toUpperCase().optional().describe("NFL team abbreviation, e.g. KC, SF, DET."),
        active_only: z.boolean().default(true).describe("Hide retired/inactive players (default true)."),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, position, team, active_only, limit }) =>
      guard(async () => {
        if (!query && !position && !team) throw new ToolError("Provide a query, position or team.");
        await ctx.players.ensureLoaded();
        const results = ctx.players.search(query, { position, team, activeOnly: active_only, limit });
        return { query, count: results.length, players: results.map(playerCard) };
      }),
  );

  server.registerTool(
    "get_player",
    {
      title: "Player details",
      description:
        "Full profile for one player by player_id or exact/near-exact name: position, team, status, injury details and practice participation, depth chart, age, experience, college, measurements, external IDs and headshot URL.",
      inputSchema: {
        player_id: z.string().trim().min(1).optional().describe("Sleeper player_id (e.g. '4046') or team defense code (e.g. 'DET')."),
        name: z.string().trim().min(1).optional().describe("Player name if you do not have the id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ player_id, name }) =>
      guard(async () => {
        await ctx.players.ensureLoaded();
        let player: Player | undefined;
        if (player_id) player = ctx.players.raw(player_id) ?? ctx.players.raw(player_id.toUpperCase());
        if (!player && name) {
          const matches = ctx.players.search(name, { limit: 5, activeOnly: false });
          player = matches[0];
          if (matches.length > 1 && matches.filter((m) => m.team).length > 1) {
            const first = matches[0]!;
            const exact = matches.filter((m) => playerFullName(m).toLowerCase() === name.toLowerCase());
            if (exact.length !== 1 && first.search_rank === null) {
              return { ambiguous: true, candidates: matches.map(playerCard) };
            }
          }
        }
        if (!player) throw new ToolError(`No player found for ${player_id ? `id ${player_id}` : `"${name}"`}. Try search_players.`);
        return playerDetails(player);
      }),
  );

  server.registerTool(
    "get_trending_players",
    {
      title: "Trending adds/drops",
      description: "Most added or most dropped players across all Sleeper leagues in the last N hours (default 24h), resolved to names. The waiver-wire pulse of the whole platform.",
      inputSchema: {
        type: z.enum(["add", "drop"]).default("add"),
        lookback_hours: z.number().int().min(1).max(168).default(24),
        limit: z.number().int().min(1).max(100).default(25),
        position: positionSchema,
        sport: sportSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ type, lookback_hours, limit, position, sport }) =>
      guard(async () => {
        const [trending] = await Promise.all([ctx.client.getTrendingPlayers(sport, type, lookback_hours, position ? Math.min(limit * 4, 100) : limit), ctx.players.ensureLoaded()]);
        let rows = trending.map((t, i) => ({ rank: i + 1, ...ctx.players.ref(t.player_id), [type === "add" ? "adds" : "drops"]: t.count }));
        if (position) rows = rows.filter((r) => r.pos === position).slice(0, limit);
        return { type, lookback_hours, count: rows.length, players: rows };
      }),
  );

  server.registerTool(
    "get_free_agents",
    {
      title: "Available free agents",
      description:
        "Players NOT on any roster in a league (the waiver wire / free-agent pool), ranked by Sleeper's overall player rank and annotated with platform-wide trending adds. Filter by position; great for waiver and streaming questions.",
      inputSchema: {
        league_id: leagueIdSchema,
        position: positionSchema,
        limit: z.number().int().min(1).max(100).default(25),
        include_injured: z.boolean().default(true).describe("Include players with an injury designation (default true, flagged with inj)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, position, limit, include_injured }) =>
      guard(async () => {
        const [bundle, trending] = await Promise.all([loadLeague(ctx, league_id), ctx.client.getTrendingPlayers("nfl", "add", 24, 100), ctx.players.ensureLoaded()]);
        const rostered = new Set<string>();
        for (const r of bundle.rosters) for (const id of r.players ?? []) rostered.add(id);
        const trendingCounts = new Map(trending.map((t) => [t.player_id, t.count]));
        const leaguePositions = new Set(bundle.league.roster_positions.flatMap((slot) => SLOT_POSITIONS[slot] ?? []));

        const pool = ctx.players
          .all()
          .filter((p) => !rostered.has(p.player_id) && isActive(p))
          .filter((p) => {
            const positions = p.fantasy_positions ?? (p.position ? [p.position] : []);
            if (position) return positions.includes(position) || p.position === position;
            return positions.some((pos) => leaguePositions.has(pos));
          })
          .filter((p) => include_injured || !p.injury_status)
          .sort((a, b) => rank(a) - rank(b))
          .slice(0, limit);

        return {
          league_id: bundle.league.league_id,
          league: bundle.league.name,
          position: position ?? "all",
          rostered_players: rostered.size,
          count: pool.length,
          free_agents: pool.map((p) => {
            const card = playerCard(p);
            const adds = trendingCounts.get(p.player_id);
            return adds ? { ...card, trending_adds_24h: adds } : card;
          }),
        };
      }),
  );
}

const SLOT_POSITIONS: Record<string, string[]> = {
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
};

function rank(p: Player): number {
  return typeof p.search_rank === "number" ? p.search_rank : Number.MAX_SAFE_INTEGER;
}

export function playerCard(p: Player) {
  const card: Record<string, unknown> = {
    player_id: p.player_id,
    name: playerFullName(p),
    pos: p.position ?? (isTeamDefense(p.player_id) ? "DEF" : null),
    team: p.team ?? (isTeamDefense(p.player_id) ? p.player_id : null),
  };
  if (p.fantasy_positions && p.fantasy_positions.length > 1) card.eligible = p.fantasy_positions;
  if (p.injury_status) card.inj = p.injury_status;
  if (p.status && p.status !== "Active") card.status = p.status;
  if (typeof p.age === "number") card.age = p.age;
  if (typeof p.years_exp === "number") card.exp = p.years_exp;
  if (p.depth_chart_order) card.depth = `${p.depth_chart_position ?? p.position}${p.depth_chart_order}`;
  if (typeof p.search_rank === "number" && p.search_rank < 9_999_999) card.rank = p.search_rank;
  return card;
}

export function playerDetails(p: Player) {
  return {
    ...playerCard(p),
    first_name: p.first_name,
    last_name: p.last_name,
    number: p.number,
    status: p.status,
    injury: p.injury_status
      ? { status: p.injury_status, body_part: p.injury_body_part ?? null, notes: p.injury_notes ?? null, since: p.injury_start_date ?? null }
      : null,
    practice: p.practice_participation ? { participation: p.practice_participation, description: p.practice_description ?? null } : null,
    depth_chart: p.depth_chart_position ? { position: p.depth_chart_position, order: p.depth_chart_order ?? null } : null,
    height: p.height,
    weight: p.weight,
    college: p.college,
    birth_date: p.birth_date ?? null,
    news_updated: isoDate(typeof p.news_updated === "number" ? p.news_updated : null),
    external_ids: { espn: p.espn_id ?? null, yahoo: p.yahoo_id ?? null, rotowire: p.rotowire_id ?? null, sportradar: p.sportradar_id ?? null, gsis: p.gsis_id ?? null },
    headshot_url: playerHeadshotUrl(p.player_id),
  };
}
