import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolError } from "../context.js";
import { SleeperApiError, SleeperNotFoundError } from "../sleeper/client.js";

/** Serialize a tool result as JSON text (plus structuredContent for clients that use it). */
export function jsonResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 1);
  const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  return structured ? { content: [{ type: "text", text }], structuredContent: structured } : { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Run a tool body, translating known failures into readable isError results. */
export async function guard(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err.message);
    if (err instanceof SleeperNotFoundError) return errorResult(err.message);
    if (err instanceof SleeperApiError) {
      if (err.status === 429) return errorResult("Sleeper is rate limiting requests right now. Wait a few seconds and try again.");
      return errorResult(`Sleeper API request failed: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected error: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

export const leagueIdSchema = z.string().trim().min(1).describe("Sleeper league ID (numeric string). Find it with get_user_leagues.");

export const usernameSchema = z.string().trim().min(1).optional().describe("Sleeper username or display name (case-insensitive).");
export const userIdSchema = z.string().trim().min(1).optional().describe("Numeric Sleeper user_id (preferred over username when known).");

export const teamSelectorShape = {
  username: usernameSchema.describe("Username or display name of the manager whose team you want."),
  user_id: userIdSchema,
  roster_id: z.number().int().positive().optional().describe("Roster ID within the league (1..N)."),
  team_name: z.string().trim().min(1).optional().describe("Team name to match (case-insensitive, partial OK)."),
};

export const seasonSchema = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Season year, e.g. 2025. Defaults to the current Sleeper league season.");

export const weekSchema = z.number().int().min(1).max(22).optional().describe("NFL week (1-18 regular season, up to 22 incl. playoffs). Defaults to the current week.");

export const positionSchema = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .describe("Position filter: QB, RB, WR, TE, K, DEF (or IDP positions DL, LB, DB).");

export const sportSchema = z.literal("nfl").default("nfl").describe("Sport. Sleeper's public API currently supports only nfl.");
