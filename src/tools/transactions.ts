import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveWeek, type LeagueBundle, type ServerContext } from "../context.js";
import type { TradedPick, Transaction } from "../sleeper/types.js";
import { isoDate, teamLabel } from "../format.js";
import { guard, leagueIdSchema, weekSchema } from "./shared.js";

export function registerTransactionTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_transactions",
    {
      title: "League transactions",
      description:
        "Trades, waiver claims and free-agent moves for a league with player names, team names, FAAB bids and traded picks resolved. Defaults to the current week; set all_weeks=true for the whole season (newest first). Filter with type.",
      inputSchema: {
        league_id: leagueIdSchema,
        week: weekSchema.describe("Week to fetch (default: current week). Ignored when all_weeks=true."),
        all_weeks: z.boolean().default(false).describe("Fetch every week of the season so far (up to 18 requests, cached)."),
        type: z.enum(["trade", "waiver", "free_agent", "commissioner"]).optional().describe("Only return this transaction type."),
        status: z.enum(["complete", "failed", "all"]).default("complete").describe("Sleeper keeps failed waiver claims too; default hides them."),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, week, all_weeks, type, status, limit }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const { week: currentWeek } = await resolveWeek(ctx, week);
        const leagueWeek = bundle.league.settings?.leg ?? currentWeek;
        const weeks = all_weeks ? Array.from({ length: Math.min(Math.max(leagueWeek, currentWeek, 1), 18) }, (_, i) => i + 1) : [week ?? currentWeek];
        const [lists] = await Promise.all([
          Promise.all(weeks.map((w) => ctx.client.getTransactions(bundle.league.league_id, w))),
          ctx.players.ensureLoaded(),
        ]);
        let all = lists.flat();
        if (type) all = all.filter((t) => t.type === type);
        if (status !== "all") all = all.filter((t) => (status === "complete" ? t.status === "complete" : t.status !== "complete"));
        all.sort((a, b) => (b.status_updated ?? b.created) - (a.status_updated ?? a.created));
        return {
          league_id: bundle.league.league_id,
          league: bundle.league.name,
          weeks: all_weeks ? `1-${weeks.length}` : weeks[0],
          total: all.length,
          returned: Math.min(all.length, limit),
          transactions: all.slice(0, limit).map((t) => describeTransaction(ctx, bundle, t)),
        };
      }),
  );

  server.registerTool(
    "get_traded_picks",
    {
      title: "Traded draft picks",
      description: "All future/current draft picks that have changed hands in a league, with original, previous and current owners resolved to team names. Grouped by current owner.",
      inputSchema: { league_id: leagueIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const picks = await ctx.client.getTradedPicks(bundle.league.league_id);
        return describeTradedPicks(bundle, picks);
      }),
  );
}

export function describeTransaction(ctx: ServerContext, bundle: LeagueBundle, t: Transaction) {
  const team = (id: number | null | undefined) => teamLabel(bundle.teams, id);
  const adds = Object.entries(t.adds ?? {}).map(([playerId, rosterId]) => ({ player: ctx.players.label(playerId), player_id: playerId, to: team(rosterId) }));
  const drops = Object.entries(t.drops ?? {}).map(([playerId, rosterId]) => ({ player: ctx.players.label(playerId), player_id: playerId, from: team(rosterId) }));
  const picks = (t.draft_picks ?? []).map((p) => ({
    pick: `${p.season} round ${p.round}`,
    original_owner: team(p.roster_id),
    from: team(p.previous_owner_id),
    to: team(p.owner_id),
  }));
  const faab = (t.waiver_budget ?? []).map((b) => ({ from: team(b.sender), to: team(b.receiver), amount: b.amount }));
  const out: Record<string, unknown> = {
    transaction_id: t.transaction_id,
    type: t.type,
    status: t.status,
    week: t.leg,
    date: isoDate(t.status_updated ?? t.created),
    teams: (t.roster_ids ?? []).map((id) => team(id)),
  };
  if (adds.length) out.adds = adds;
  if (drops.length) out.drops = drops;
  if (picks.length) out.draft_picks = picks;
  if (faab.length) out.faab_transfers = faab;
  if (t.settings?.waiver_bid !== undefined) out.faab_bid = t.settings.waiver_bid;
  if (t.metadata?.notes) out.notes = t.metadata.notes;
  if (t.type === "trade") {
    // Summarize what each side gave/received for quick reading.
    const sides: Record<string, { gave: string[]; got: string[] }> = {};
    const ensure = (name: string | null) => {
      const key = name ?? "unknown";
      return (sides[key] ??= { gave: [], got: [] });
    };
    for (const a of adds) ensure(a.to).got.push(a.player);
    for (const d of drops) ensure(d.from).gave.push(d.player);
    for (const p of picks) {
      ensure(p.to).got.push(p.pick);
      ensure(p.from).gave.push(p.pick);
    }
    for (const f of faab) {
      ensure(f.to).got.push(`$${f.amount} FAAB`);
      ensure(f.from).gave.push(`$${f.amount} FAAB`);
    }
    out.trade_summary = sides;
  }
  return out;
}

export function describeTradedPicks(bundle: LeagueBundle, picks: TradedPick[]) {
  const byOwner = new Map<string, unknown[]>();
  const sorted = [...picks].sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
  for (const p of sorted) {
    const owner = teamLabel(bundle.teams, p.owner_id) ?? `Roster ${p.owner_id}`;
    const list = byOwner.get(owner) ?? [];
    list.push({
      pick: `${p.season} round ${p.round}`,
      season: p.season,
      round: p.round,
      original_owner: teamLabel(bundle.teams, p.roster_id),
      previous_owner: teamLabel(bundle.teams, p.previous_owner_id),
    });
    byOwner.set(owner, list);
  }
  return {
    league_id: bundle.league.league_id,
    league: bundle.league.name,
    total: picks.length,
    by_current_owner: Object.fromEntries(byOwner),
  };
}
