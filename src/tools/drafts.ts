import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError, hasTeamSelector, loadLeague, resolveRoster, resolveSeason, resolveUserId, type ServerContext } from "../context.js";
import { SleeperNotFoundError } from "../sleeper/client.js";
import type { Draft, DraftPick, LeagueUser } from "../sleeper/types.js";
import { isoDate } from "../format.js";
import { guard, leagueIdSchema, seasonSchema, sportSchema, teamSelectorShape, userIdSchema, usernameSchema } from "./shared.js";

const draftIdSchema = z.string().trim().min(1).describe("Sleeper draft ID. Find it via get_drafts or a league's draft_id.");

export function registerDraftTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_drafts",
    {
      title: "List drafts",
      description: "Drafts for a league (all of them, newest first) or for a user in a season. Returns draft_id, type (snake/linear/auction), status, start time, rounds and scoring type.",
      inputSchema: {
        league_id: z.string().trim().min(1).optional().describe("List drafts for this league."),
        username: usernameSchema.describe("Or list drafts for this user (with season)."),
        user_id: userIdSchema,
        season: seasonSchema,
        sport: sportSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, username, user_id, season, sport }) =>
      guard(async () => {
        let drafts: Draft[];
        let scope: Record<string, unknown>;
        if (league_id) {
          drafts = await ctx.client.getLeagueDrafts(league_id);
          scope = { league_id };
        } else if (username || user_id) {
          const userId = await resolveUserId(ctx, { username, user_id });
          const resolvedSeason = await resolveSeason(ctx, season, sport);
          drafts = await ctx.client.getUserDrafts(userId, sport, resolvedSeason);
          scope = { user_id: userId, season: resolvedSeason };
        } else {
          throw new ToolError("Provide league_id, or username/user_id (+ optional season).");
        }
        return { ...scope, count: drafts.length, drafts: drafts.map(draftCard) };
      }),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Draft details",
      description: "Settings and status of a draft plus the draft order (slot → manager → roster_id). Pass a draft_id, or a league_id to use that league's most recent draft.",
      inputSchema: {
        draft_id: z.string().trim().min(1).optional().describe("Draft ID."),
        league_id: z.string().trim().min(1).optional().describe("Alternatively, the league whose latest draft you want."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ draft_id, league_id }) =>
      guard(async () => {
        const draft = await resolveDraft(ctx, draft_id, league_id);
        const users = draft.league_id ? await ctx.client.getLeagueUsers(draft.league_id).catch(() => [] as LeagueUser[]) : [];
        return describeDraft(draft, users);
      }),
  );

  server.registerTool(
    "get_draft_picks",
    {
      title: "Draft picks",
      description:
        "Every pick in a draft with player, position, team, round, overall pick, drafting manager and auction price (if applicable). Filter by round, or by a team (username/roster_id/team_name) to see one manager's draft. Live drafts update as picks come in.",
      inputSchema: {
        draft_id: z.string().trim().min(1).optional().describe("Draft ID."),
        league_id: z.string().trim().min(1).optional().describe("Alternatively, the league whose latest draft you want."),
        round: z.number().int().min(1).max(60).optional().describe("Only this round."),
        ...teamSelectorShape,
        limit: z.number().int().min(1).max(1000).default(400),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ draft_id, league_id, round, limit, ...selector }) =>
      guard(async () => {
        const draft = await resolveDraft(ctx, draft_id, league_id);
        const [picks, users] = await Promise.all([
          ctx.client.getDraftPicks(draft.draft_id),
          draft.league_id ? ctx.client.getLeagueUsers(draft.league_id).catch(() => [] as LeagueUser[]) : Promise.resolve([] as LeagueUser[]),
          ctx.players.ensureLoaded(),
        ]);
        const byUser = new Map(users.map((u) => [u.user_id, u.display_name ?? u.username ?? u.user_id]));
        let filtered = picks;
        if (round !== undefined) filtered = filtered.filter((p) => p.round === round);
        const wantsTeam = hasTeamSelector(selector);
        if (wantsTeam) {
          if (!draft.league_id) throw new ToolError("This draft is not attached to a league, so picks cannot be filtered by team.");
          const bundle = await loadLeague(ctx, draft.league_id);
          const roster = await resolveRoster(ctx, bundle, selector);
          filtered = filtered.filter((p) => Number(p.roster_id) === roster.roster_id || (p.picked_by && p.picked_by === roster.owner_id));
        }
        const teams = draft.settings?.teams ?? 0;
        return {
          draft_id: draft.draft_id,
          league_id: draft.league_id,
          type: draft.type,
          status: draft.status,
          season: draft.season,
          total_picks: picks.length,
          returned: Math.min(filtered.length, limit),
          picks: filtered.slice(0, limit).map((p) => describePick(ctx, p, byUser, teams)),
        };
      }),
  );
}

async function resolveDraft(ctx: ServerContext, draftId: string | undefined, leagueId: string | undefined): Promise<Draft> {
  if (draftId) {
    try {
      return await ctx.client.getDraft(draftId);
    } catch (err) {
      if (err instanceof SleeperNotFoundError) throw new ToolError(`Draft ${draftId} was not found.`);
      throw err;
    }
  }
  if (leagueId) {
    const drafts = await ctx.client.getLeagueDrafts(leagueId);
    const latest = drafts[0];
    if (!latest) throw new ToolError(`League ${leagueId} has no drafts.`);
    return latest;
  }
  throw new ToolError("Provide draft_id or league_id.");
}

export function draftCard(d: Draft) {
  return {
    draft_id: d.draft_id,
    league_id: d.league_id,
    name: d.metadata?.name ?? null,
    type: d.type,
    status: d.status,
    season: d.season,
    teams: d.settings?.teams ?? null,
    rounds: d.settings?.rounds ?? null,
    scoring_type: d.metadata?.scoring_type ?? null,
    start_time: isoDate(d.start_time),
    last_pick_at: isoDate(d.last_picked),
  };
}

export function describeDraft(d: Draft, users: LeagueUser[]) {
  const byUser = new Map(users.map((u) => [u.user_id, u.display_name ?? u.username ?? u.user_id]));
  const order = Object.entries(d.draft_order ?? {})
    .map(([userId, slot]) => ({ slot, manager: byUser.get(userId) ?? userId, user_id: userId, roster_id: d.slot_to_roster_id?.[String(slot)] ?? null }))
    .sort((a, b) => a.slot - b.slot);
  const s = d.settings ?? {};
  return {
    ...draftCard(d),
    pick_timer_seconds: s.pick_timer ?? null,
    auction_budget: d.type === "auction" ? (s.budget ?? null) : undefined,
    reversal_round: s.reversal_round || undefined,
    slots: {
      qb: s.slots_qb,
      rb: s.slots_rb,
      wr: s.slots_wr,
      te: s.slots_te,
      flex: s.slots_flex,
      super_flex: s.slots_super_flex,
      k: s.slots_k,
      def: s.slots_def,
      bn: s.slots_bn,
    },
    draft_order: order,
  };
}

export function describePick(ctx: ServerContext, p: DraftPick, byUser: Map<string, string>, teams: number) {
  const ref = ctx.players.ref(p.player_id);
  const meta = p.metadata ?? {};
  const out: Record<string, unknown> = {
    pick_no: p.pick_no,
    round: p.round,
    pick_in_round: teams > 0 ? ((p.pick_no - 1) % teams) + 1 : undefined,
    draft_slot: p.draft_slot,
    player: ref.name,
    player_id: p.player_id,
    pos: ref.pos ?? meta.position ?? null,
    team: ref.team ?? meta.team ?? null,
    picked_by: p.picked_by ? (byUser.get(p.picked_by) ?? p.picked_by) : null,
    roster_id: p.roster_id === null || p.roster_id === undefined ? null : Number(p.roster_id),
  };
  if (p.is_keeper) out.keeper = true;
  if (meta.amount) out.price = Number(meta.amount);
  if (ref.inj) out.inj = ref.inj;
  return out;
}
