import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, resolveWeek, ToolError, type ServerContext } from "../context.js";
import { round, startingSlots, teamLabel } from "../format.js";
import { loadWeekGames } from "../games.js";
import { injuryMetadata } from "../injuries/context.js";
import { validateLineupLocksFromSnapshot } from "../lineups.js";
import { winProbability } from "../odds.js";
import type { Matchup } from "../sleeper/types.js";
import { planLineup } from "./account.js";
import { sideOutlook, starterViews } from "./odds.js";
import { guard, leagueIdSchema, teamSelectorShape } from "./shared.js";

const player = z.string().trim().min(1).max(150);
const scenarioSchema = z.object({
  name: z.string().trim().min(1).max(80).describe("Unique name for this scenario."),
  moves: z.array(z.object({
    start: player,
    bench: player.optional(),
    slot: z.string().trim().toUpperCase().optional(),
  })).min(1).max(20).optional().describe("Start/bench swaps, each applied to the original current lineup, not the preceding scenario."),
  starters: z.array(player).min(1).max(100).optional().describe("Alternative to moves: full lineup in league slot order; use '0' for an empty slot."),
}).refine((s) => Boolean(s.moves) !== Boolean(s.starters), { message: "Each scenario must provide exactly one of moves or starters." });

export function registerLineupComparisonTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "compare_lineups",
    {
      title: "Compare hypothetical lineups",
      description:
        "Read-only comparison of the current scoring-week lineup with up to five named scenarios (moves or full starters). Reuses one fetched set of league scoring, weekly matchup points, projections, game states and injury context for every scenario. Returns projected point deltas and approximate head-to-head win-probability deltas in percentage points. Validates roster membership, slot eligibility, IR/taxi, duplicates and kickoff locks. Invalid scenarios return errors without discarding valid ones. Does not set a lineup, add/drop, trade or submit claims.",
      inputSchema: {
        league_id: leagueIdSchema,
        ...teamSelectorShape,
        scenarios: z.array(scenarioSchema).min(1).max(5),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, scenarios, ...selector }) =>
      guard(async () => {
        const collectionStartedAt = new Date().toISOString();
        if (new Set(scenarios.map((s) => s.name.toLowerCase())).size !== scenarios.length) {
          throw new ToolError("Scenario names must be unique.");
        }
        const [bundle, { week, state }] = await Promise.all([loadLeague(ctx, league_id), resolveWeek(ctx, undefined), ctx.players.ensureLoaded()]);
        if (bundle.league.season !== state.season || state.season_type !== "regular" ||
            bundle.league.status !== "in_season" || bundle.league.settings?.leg !== week) {
          throw new ToolError("compare_lineups supports the current regular-season NFL week in an active, synchronized league only.");
        }
        if (Number(bundle.league.settings?.best_ball) === 1) throw new ToolError("Best-ball leagues select starters automatically; manual lineup comparisons are not supported.");
        const owned = await resolveRoster(ctx, bundle, selector);
        const [matchups, projections, games] = await Promise.all([
          ctx.client.getMatchups(bundle.league.league_id, week),
          ctx.client.getProjections("nfl", "regular", bundle.league.season, week),
          loadWeekGames(ctx, bundle.league.season, week, state, true),
        ]);
        if (!Object.keys(projections).length) throw new ToolError("No projections are available for the current week; cannot estimate scenario differences.");
        if (games.source !== "schedule") throw new ToolError("Cannot safely compare lineup changes without the NFL schedule and kickoff locks.");
        const ownMatches = matchups.filter((m) => m.roster_id === owned.roster_id);
        if (ownMatches.length !== 1) throw new ToolError("No unambiguous weekly lineup for this roster; roster defaults are not a scoring lineup.");
        const slots = startingSlots(bundle.league);
        const normalize = (m: Matchup): Matchup => {
          if (!Array.isArray(m.starters) || m.starters.some((id) => typeof id !== "string") ||
              (m.starters.length !== slots.length && m.starters.length !== 0)) {
            throw new ToolError(`Weekly starters for roster ${m.roster_id} are missing or malformed.`);
          }
          const filled = m.starters.filter((id) => id !== "0");
          if (new Set(filled).size !== filled.length) throw new ToolError(`Weekly starters for roster ${m.roster_id} contain duplicates.`);
          return { ...m, starters: m.starters.length ? [...m.starters] : Array<string>(slots.length).fill("0") };
        };
        const current = normalize(ownMatches[0]!);
        const roster = { ...owned, starters: current.starters };
        const rivals = current.matchup_id == null ? [] : matchups.filter((m) => m.matchup_id === current.matchup_id && m.roster_id !== current.roster_id);
        let opponent: Matchup | null = null;
        let oddsUnavailable: string | null = null;
        if (rivals.length !== 1) oddsUnavailable = "No single head-to-head opponent for this week; win probability is unavailable.";
        else {
          try {
            opponent = normalize(rivals[0]!);
            if (opponent.starters!.every((id) => id === "0")) {
              opponent = null;
              oddsUnavailable = "The opponent has no populated starting lineup; win probability is unavailable.";
            }
          } catch {
            oddsUnavailable = "The opponent's weekly lineup is missing or malformed; win probability is unavailable.";
          }
        }
        const ids = [...new Set([...(owned.players ?? []), ...current.starters!, ...(opponent?.starters ?? [])])].filter((id) => id !== "0");
        const injuries = await ctx.injuries.report(ids);
        const capturedAt = new Date().toISOString();
        // No network calls below: all scenarios use the same collected input objects.
        const score = (m: Matchup) => {
          const views = starterViews(ctx, bundle, m, projections, games);
          return { views, outlook: sideOutlook(m, views) };
        };
        const other = opponent ? score(opponent) : null;
        const base = score(current);
        const probability = (s: ReturnType<typeof score>) => other ? winProbability(s.outlook, other.outlook) : null;
        const baselineProbability = probability(base);
        const warningsFor = (m: Matchup, s: ReturnType<typeof score>) => {
          const warnings: string[] = [];
          if (typeof m.custom_points === "number") warnings.push("Commissioner custom_points overrides the team total; lineup swaps do not change that modeled total.");
          for (const p of s.views) {
            if (p.id === "0") { warnings.push(`Empty ${p.slot} slot.`); continue; }
            if (p.state === "final" || p.state === "playing") continue;
            const name = ctx.players.ref(p.id).name;
            if (p.state === "bye" || p.state === "no_game") warnings.push(`${name}: ${p.state === "bye" ? "on bye" : "no scheduled game"}; no remaining points.`);
            else if (!projections[p.id]) warnings.push(`${name}: no Sleeper projection; remaining points are modeled as zero.`);
            const context = injuries.byPlayer.get(p.id);
            if (context?.needs_check) warnings.push(`${name}: ${context.reasons.join(" ")}`);
            else if (context?.designation) warnings.push(`${name}: reported ${context.designation}; review the sourced injury context.`);
          }
          return warnings;
        };
        const describe = (m: Matchup, s: ReturnType<typeof score>) => ({
          points_so_far: round(s.outlook.points, 2),
          projected_total: round(s.outlook.mean, 2),
          starters: s.views.map((p) => ({
            ...(p.id === "0" ? { id: "0", name: "(empty)", pos: null, team: null } : ctx.players.ref(p.id)),
            slot: p.slot, status: p.state, locked: p.state === "final" || p.state === "playing",
            points_so_far: round(p.points, 2),
            projected_final: round(p.points + p.projection * p.remaining, 2),
          })),
          warnings: warningsFor(m, s),
        });
        const results = scenarios.map((scenario) => {
          try {
            const plan = planLineup(ctx, bundle, roster, scenario);
            validateLineupLocksFromSnapshot(ctx, bundle, roster, plan.starters, games);
            const hypothetical = { ...current, starters: plan.starters };
            const scored = score(hypothetical);
            const win = probability(scored);
            return {
              name: scenario.name, valid: true, changes: plan.changes, ...describe(hypothetical, scored),
              projected_points_delta: round(scored.outlook.mean - base.outlook.mean, 2),
              win_pct: win === null ? null : round(win * 100, 1),
              win_probability_delta_pp: win === null || baselineProbability === null ? null : round((win - baselineProbability) * 100, 1),
            };
          } catch (err) {
            if (!(err instanceof ToolError)) throw err;
            return { name: scenario.name, valid: false, error: err.message };
          }
        });
        return {
          league_id: bundle.league.league_id, league: bundle.league.name, season: bundle.league.season, week,
          team: teamLabel(bundle.teams, roster.roster_id), read_only: true,
          snapshot: {
            collection_started_at: collectionStartedAt, captured_at: capturedAt,
            lineup_source: "public_weekly_matchups", game_status_source: games.source,
            note: "One collected input set is reused for every scenario, not an atomic upstream snapshot. Public roster/matchup data can lag recent changes; normal source caches still apply.",
          },
          baseline: { ...describe(current, base), win_pct: baselineProbability === null ? null : round(baselineProbability * 100, 1) },
          opponent: opponent && other ? { roster_id: opponent.roster_id, team: teamLabel(bundle.teams, opponent.roster_id), points_so_far: round(other.outlook.points, 2), projected_total: round(other.outlook.mean, 2), warnings: warningsFor(opponent, other) } : null,
          odds_unavailable_reason: oddsUnavailable,
          scenarios: results,
          injury_data: injuryMetadata(injuries),
          injury_context: ids.filter((id) => {
            const context = injuries.byPlayer.get(id);
            return context?.needs_check || context?.designation;
          }).map((id) => ({ ...ctx.players.ref(id), injury_context: injuries.byPlayer.get(id)! })),
          method: "Uses the existing matchup-odds model: league-scored projections for game time remaining plus points already scored, with independent position-based variance. Win probabilities are approximate, not Sleeper's official odds. Deltas are percentage points; questionable status and ESPN reports do not adjust the model.",
        };
      }),
  );
}
