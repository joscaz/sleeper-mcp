/**
 * Live smoke test against the real Sleeper API.
 *
 *   npm run smoke
 *   SLEEPER_USERNAME=yourname npm run smoke   # also exercises your own leagues
 *
 * Uses Sleeper's documented example league (a completed 2018 season) so it works year-round.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";

const DOCS_LEAGUE = "289646328504385536";

async function main() {
  const { server, ctx } = createServer({ log: (m) => console.error(`  [log] ${m}`), preloadPlayers: false });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(ct);

  let failures = 0;
  const call = async (name: string, args: Record<string, unknown>, check: (data: Record<string, unknown>) => string) => {
    const started = Date.now();
    try {
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = res.content.find((c) => c.type === "text")?.text ?? "";
      if (res.isError) throw new Error(text);
      const summary = check(JSON.parse(text));
      console.log(`✔ ${name} ${JSON.stringify(args)} → ${summary} (${Date.now() - started}ms)`);
    } catch (err) {
      failures++;
      console.log(`✘ ${name} ${JSON.stringify(args)} → ${(err as Error).message}`);
    }
  };

  console.log("Loading player database…");
  const t0 = Date.now();
  await ctx.players.ensureLoaded();
  console.log(`  ${ctx.players.count} players in ${Date.now() - t0}ms\n`);

  await call("get_nfl_state", {}, (d) => `season ${d.season} ${d.season_type} week ${d.week}`);
  await call("search_players", { query: "mahomes" }, (d) => `${d.count} hit(s): ${(d.players as { name: string }[]).map((p) => p.name).join(", ")}`);
  await call("get_player", { name: "Justin Jefferson" }, (d) => `${d.name} ${d.pos} ${d.team}`);
  await call("get_trending_players", { limit: 5 }, (d) => (d.players as { name: string; adds: number }[]).map((p) => `${p.name} +${p.adds}`).join(", "));
  await call("get_league", { league_id: DOCS_LEAGUE }, (d) => `${d.name} (${d.season}, ${(d.scoring as { format: string }).format}, ${d.teams} teams, ${d.status})`);
  await call("get_league_standings", { league_id: DOCS_LEAGUE }, (d) => {
    const top = (d.standings as { team_name: string; record: string; points_for: number }[])[0]!;
    return `#1 ${top.team_name} ${top.record}, ${top.points_for} PF`;
  });
  await call("get_league_rosters", { league_id: DOCS_LEAGUE, include_bench: false }, (d) => `${d.teams} rosters`);
  await call("get_roster", { league_id: DOCS_LEAGUE, roster_id: 1 }, (d) => `${d.team_name}: ${(d.starters as { name: string }[]).length} starters, ${(d.bench as unknown[]).length} bench`);
  await call("get_matchups", { league_id: DOCS_LEAGUE, week: 1 }, (d) => `${(d.matchups as unknown[]).length} matchups in week ${d.week}`);
  await call("get_playoff_bracket", { league_id: DOCS_LEAGUE }, (d) => {
    const b = d.winners_bracket as { matches: { label: string; winner: string | null }[] };
    const final = b.matches.find((m) => m.label === "Championship");
    return `${b.matches.length} matches; champion ${final?.winner ?? "?"}`;
  });
  await call("get_transactions", { league_id: DOCS_LEAGUE, all_weeks: true, limit: 5 }, (d) => `${d.total} transactions across weeks ${d.weeks}`);
  await call("get_traded_picks", { league_id: DOCS_LEAGUE }, (d) => `${d.total} traded picks`);
  await call("get_drafts", { league_id: DOCS_LEAGUE }, (d) => `${d.count} draft(s)`);
  await call("get_draft_picks", { league_id: DOCS_LEAGUE, round: 1 }, (d) => `${d.returned} first-round picks, 1.01 = ${(d.picks as { player: string }[])[0]?.player}`);
  await call("get_free_agents", { league_id: DOCS_LEAGUE, position: "RB", limit: 3 }, (d) => (d.free_agents as { name: string }[]).map((p) => p.name).join(", "));
  await call("get_league_history", { league_id: DOCS_LEAGUE, max_seasons: 2 }, (d) => `${d.seasons_found} season(s)`);
  await call("get_projections", { position: "QB", limit: 3 }, (d) => `${d.season} wk ${d.week}: ` + (d.players as { name: string; pts: number }[]).map((p) => `${p.name} ${p.pts}`).join(", "));
  await call("get_player_stats", { week: 0, position: "RB", limit: 3, season: "2025" }, (d) => `${d.season} season: ` + (d.players as { name: string; pts: number }[]).map((p) => `${p.name} ${p.pts}`).join(", "));

  const username = process.env.SLEEPER_USERNAME;
  if (username) {
    console.log(`\nUser-specific checks for ${username}:`);
    await call("get_user", { username }, (d) => `user_id ${d.user_id}`);
    await call("get_user_leagues", { username }, (d) => `${d.count} league(s) in ${d.season}`);
    const leagues = (await client.callTool({ name: "get_user_leagues", arguments: { username } })) as CallToolResult;
    const first = (JSON.parse(leagues.content[0]!.type === "text" ? leagues.content[0]!.text : "{}") as { leagues?: { league_id: string }[] }).leagues?.[0];
    if (first) {
      await call("get_roster", { league_id: first.league_id, username }, (d) => `${d.team_name} ${d.record}`);
      await call("get_matchups", { league_id: first.league_id, username }, (d) => `week ${d.week}: ${(d.matchups as unknown[]).length} matchup(s)`);
      await call("get_lineup_projections", { league_id: first.league_id, username }, (d) => `current ${d.current_projected_total} vs optimal ${d.optimal_projected_total}`);
    }
  }

  await client.close();
  await server.close();
  console.log(`\n${failures === 0 ? "All smoke checks passed" : `${failures} smoke check(s) failed`}; ${ctx.client.requestsSent} HTTP requests sent.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
