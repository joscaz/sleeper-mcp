import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, ToolError, type ServerContext } from "../context.js";
import { injuryMetadata } from "../injuries/context.js";
import { guard, leagueIdSchema, teamSelectorShape } from "./shared.js";

export function registerInjuryTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_injury_report",
    {
      title: "Sourced injury context",
      description:
        "Injury context for a roster or selected player_ids: each source's designation, report time, retrieval time, cache expiry, stale flag, and source link. Highlights questionable players, conflicting reports and ambiguous identity without recommending an automatic bench. Optional ESPN enrichment must be enabled by the server; basic Sleeper reads keep working if it fails. Missing from a feed does not mean healthy. Current context only, not historical injury data.",
      inputSchema: {
        league_id: leagueIdSchema.optional(),
        ...teamSelectorShape,
        player_ids: z.array(z.string().trim().min(1)).min(1).max(100).optional().describe("Sleeper player IDs (use search_players for names). Overrides roster selection."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, player_ids, ...selector }) =>
      guard(async () => {
        let ids = player_ids;
        if (!ids) {
          if (!league_id) throw new ToolError("Provide league_id to check a roster, or player_ids.");
          const bundle = await loadLeague(ctx, league_id);
          ids = (await resolveRoster(ctx, bundle, selector)).players ?? [];
        }
        const report = await ctx.injuries.report(ids);
        const players = [...new Set(ids)].filter((id) => report.byPlayer.has(id)).map((id) => ({
          ...ctx.players.ref(id), injury_context: report.byPlayer.get(id)!,
        }));
        return {
          as_of: new Date().toISOString(),
          injury_data: injuryMetadata(report),
          count: players.length,
          needs_check: players.filter((p) => p.injury_context.needs_check).length,
          players,
          unknown_player_ids: ids.filter((id) => !ctx.players.raw(id)),
        };
      }),
  );
}
