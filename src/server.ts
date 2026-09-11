import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { createContext, loadLeague, type ContextOptions, type ServerContext } from "./context.js";
import { registerLeagueTools, leagueDetails } from "./tools/leagues.js";
import { registerRosterTools } from "./tools/rosters.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerDraftTools } from "./tools/drafts.js";
import { registerPlayerTools } from "./tools/players.js";
import { registerStatTools } from "./tools/stats.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const SERVER_NAME = "sleeper-mcp";
export const SERVER_VERSION: string = pkg.version;

export const SERVER_INSTRUCTIONS = `Sleeper fantasy football (read-only public API, no login required).

Typical flow:
1. get_user / get_user_leagues to turn a username into league_ids.
2. get_league (settings) and get_league_standings (records + roster_id ↔ manager map).
3. get_roster / get_matchups / get_transactions / get_free_agents / get_lineup_projections for the actual questions.

Notes:
- Player ids are resolved to {id, name, pos, team, inj} everywhere; team defenses use team codes (e.g. "DET").
- "week" defaults to the current NFL week from get_nfl_state; "season" defaults to the current league season.
- Any team can be selected by username, user_id, roster_id or team_name.
- Data is cached briefly (20s–5min); the player database refreshes daily.`;

export interface CreateServerOptions extends ContextOptions {
  /** Kick off the player-map download in the background as soon as the server is created (default true). */
  preloadPlayers?: boolean;
}

export function createServer(options: CreateServerOptions = {}): { server: McpServer; ctx: ServerContext } {
  const ctx = createContext(options);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerLeagueTools(server, ctx);
  registerRosterTools(server, ctx);
  registerTransactionTools(server, ctx);
  registerDraftTools(server, ctx);
  registerPlayerTools(server, ctx);
  registerStatTools(server, ctx);
  registerPrompts(server);
  registerResources(server, ctx);

  if (options.preloadPlayers ?? true) {
    ctx.players.ensureLoaded().catch((err: Error) => ctx.log(`player preload failed: ${err.message}`));
  }

  return { server, ctx };
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "weekly_briefing",
    {
      title: "Weekly briefing",
      description: "A manager's week at a glance: matchup, lineup check, waiver targets and league news.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        username: z.string().describe("Manager's Sleeper username"),
        week: z.string().optional().describe("Week number (default: current)"),
      },
    },
    ({ league_id, username, week }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Prepare a concise weekly fantasy football briefing for Sleeper user "${username}" in league ${league_id}${week ? ` for week ${week}` : ""}.`,
              "",
              "Steps:",
              "1. get_league for scoring/roster format, get_league_standings for records and playoff picture.",
              `2. get_matchups for ${username}'s matchup: opponent, projected/actual score, key players on both sides.`,
              `3. get_lineup_projections for ${username}: flag empty slots, injured/bye starters, and better bench options.`,
              "4. get_free_agents (top few at the weakest positions) and get_trending_players to suggest waiver targets.",
              "5. get_transactions (this week) for notable league moves and trades.",
              "",
              "Output: matchup preview, lineup recommendations with reasons, 3-5 waiver targets, league news. Keep it tight and specific.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "waiver_wire_report",
    {
      title: "Waiver wire report",
      description: "Best available players for a team given its needs, FAAB and the league's scoring.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        username: z.string().describe("Manager's Sleeper username"),
      },
    },
    ({ league_id, username }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Build a waiver-wire report for "${username}" in Sleeper league ${league_id}.`,
              "",
              "Use get_league (scoring, roster slots, waiver type/FAAB budget), get_roster (current depth, injuries, FAAB remaining),",
              "get_free_agents per position of need, get_trending_players (what the market is chasing) and get_projections for the upcoming week.",
              "",
              "Recommend up to 5 claims ranked by priority, each with: who to add, who to drop, a suggested FAAB bid or waiver priority use, and a one-line reason.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "trade_analysis",
    {
      title: "Trade analysis",
      description: "Evaluate a proposed trade between two teams using rosters, scoring, projections and league context.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        team_a: z.string().describe("First team (username or team name)"),
        team_b: z.string().describe("Second team (username or team name)"),
        proposal: z.string().describe("The trade, e.g. 'A gives Bijan Robinson for B's CeeDee Lamb and a 2027 2nd'"),
      },
    },
    ({ league_id, team_a, team_b, proposal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Analyze this trade in Sleeper league ${league_id} between ${team_a} and ${team_b}: ${proposal}`,
              "",
              "Use get_league (scoring format, league type, roster slots, trade deadline), get_roster for both teams, get_league_standings (contender vs rebuilder),",
              "get_projections (rest-of-season with week=0 where useful) and get_traded_picks if picks are involved.",
              "",
              "Cover: positional needs each side fills, starting-lineup impact, depth after the trade, dynasty/keeper value if applicable, and a verdict on who wins and whether each side should accept.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "nfl-state",
    "sleeper://nfl/state",
    { title: "NFL state", description: "Current NFL season and week per Sleeper.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await ctx.client.getNflState("nfl"), null, 1) }],
    }),
  );

  server.registerResource(
    "league",
    new ResourceTemplate("sleeper://league/{league_id}", { list: undefined }),
    { title: "League settings", description: "Summarized settings for a Sleeper league.", mimeType: "application/json" },
    async (uri, { league_id }) => {
      const id = Array.isArray(league_id) ? league_id[0] : league_id;
      const { league, users } = await loadLeague(ctx, String(id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(leagueDetails(league, users, false), null, 1) }] };
    },
  );
}
