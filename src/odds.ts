/**
 * Win probability and season simulation for fantasy matchups.
 *
 * The model is deliberately simple and explainable:
 * - A starter's remaining points are normally distributed around their league-scored projection for the
 *   share of their game still to play. The spread is a fixed fraction of the projection that depends on
 *   position (defenses and tight ends swing more than quarterbacks).
 * - A team's final score is its points so far plus its starters' remaining points, so its variance is the
 *   sum of the starters' variances (players are treated as independent).
 * - Season simulations also give each team a projection error drawn once per simulated season, so a team the
 *   projections misjudge stays misjudged for the whole run instead of averaging out week to week.
 */

/** Weekly standard deviation of fantasy points as a fraction of the projection, by position. */
export const POSITION_SPREAD: Readonly<Record<string, number>> = {
  QB: 0.4,
  RB: 0.55,
  WR: 0.6,
  TE: 0.65,
  K: 0.55,
  DEF: 0.8,
  DL: 0.55,
  DE: 0.55,
  DT: 0.6,
  LB: 0.5,
  DB: 0.55,
  CB: 0.6,
  S: 0.55,
};

const DEFAULT_SPREAD = 0.6;

/** Season-long projection error, as a fraction of a team's average projected weekly score. */
export const TEAM_PROJECTION_ERROR = 0.07;

export function spreadFor(pos: string | null | undefined): number {
  return (pos ? POSITION_SPREAD[pos] : undefined) ?? DEFAULT_SPREAD;
}

export interface ScoreDistribution {
  mean: number;
  variance: number;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26; absolute error below 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Probability that A outscores B; an exact tie counts as half. */
export function winProbability(a: ScoreDistribution, b: ScoreDistribution): number {
  const diff = a.mean - b.mean;
  const variance = a.variance + b.variance;
  if (variance < 1e-9) return diff > 1e-9 ? 1 : diff < -1e-9 ? 0 : 0.5;
  return normalCdf(diff / Math.sqrt(variance));
}

export interface StarterOutlook {
  /** League-scored points already on the board. */
  points: number;
  /** Full-game projection under league scoring. */
  projection: number;
  /** Share of the player's game still to play: 1 before kickoff, 0 when final or when there is no game. */
  remaining: number;
  pos: string | null;
}

export interface TeamOutlook extends ScoreDistribution {
  /** Points already scored. */
  points: number;
  /** Projected points still to come. */
  still_to_come: number;
}

/** Final-score distribution for a lineup: points so far plus each starter's projection for the time left. */
export function teamOutlook(starters: readonly StarterOutlook[]): TeamOutlook {
  let points = 0;
  let toCome = 0;
  let variance = 0;
  for (const s of starters) {
    points += s.points;
    if (s.remaining <= 0 || s.projection <= 0) continue;
    toCome += s.projection * s.remaining;
    const sd = spreadFor(s.pos) * s.projection;
    variance += sd * sd * s.remaining;
  }
  return { points, still_to_come: toCome, mean: points + toCome, variance };
}

/** Seeds that skip the first round of a single-elimination bracket: 6 teams → 2, 12 → 4, powers of two → 0. */
export function firstRoundByes(playoffTeams: number): number {
  if (playoffTeams < 3) return 0;
  let size = 1;
  while (size < playoffTeams) size *= 2;
  return size - playoffTeams;
}

// ---------------------------------------------------------------------------
// Deterministic randomness: the same data and seed always give the same odds.
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string, for stable seeds. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Standard normal draws (Box–Muller) from a uniform generator. */
export function normalSampler(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = rng();
    while (u <= Number.EPSILON) u = rng();
    const v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// ---------------------------------------------------------------------------
// Season simulation
// ---------------------------------------------------------------------------

export interface SimTeam {
  roster_id: number;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
}

export interface SimWeek {
  week: number;
  /** Head-to-head pairs of roster_ids, or null when the schedule is unknown (pairs are then drawn at random). */
  pairs: [number, number][] | null;
  /** Score distribution per roster_id. Teams missing from the map do not play that week. */
  scores: Map<number, ScoreDistribution>;
  /** Weeks that have not started carry each team's season-long projection error; the week in progress does not. */
  projected: boolean;
}

export interface SimOptions {
  simulations: number;
  seed: number;
  playoffTeams: number;
  /** Top seeds that skip the first playoff round. */
  byes: number;
  /** Every team also plays the league median each week (Sleeper's league_average_match). */
  medianGame?: boolean;
  /** Override TEAM_PROJECTION_ERROR. */
  teamError?: number;
  /** roster_id to break down by the first simulated week's result and by final win total. */
  focusRosterId?: number;
}

export interface SimTeamResult {
  roster_id: number;
  /** Probabilities in [0, 1]. */
  playoffs: number;
  bye: number;
  top_seed: number;
  avg_seed: number;
  avg_wins: number;
  avg_losses: number;
  avg_ties: number;
}

export interface SimFocus {
  roster_id: number;
  playoffs: number;
  first_week: {
    week: number;
    opponent: number | null;
    win: number;
    playoffs_if_win: number | null;
    playoffs_if_loss: number | null;
  } | null;
  /** Final win totals (ties count half) with how often they happen and how often they get in. */
  by_final_wins: { wins: number; share: number; playoffs: number }[];
}

export interface SimResult {
  simulations: number;
  teams: SimTeamResult[];
  focus: SimFocus | null;
}

/**
 * Monte Carlo over the remaining weeks. Final standings sort by wins (ties count half), then points for,
 * which is how Sleeper orders its standings.
 */
export function simulateSeason(teams: readonly SimTeam[], weeks: readonly SimWeek[], options: SimOptions): SimResult {
  const n = teams.length;
  const sims = Math.max(1, Math.floor(options.simulations));
  const idx = new Map(teams.map((t, i) => [t.roster_id, i]));
  const playoffTeams = Math.min(n, Math.max(0, options.playoffTeams));
  const byes = Math.min(playoffTeams, Math.max(0, options.byes));
  const teamError = options.teamError ?? TEAM_PROJECTION_ERROR;
  const zeros = () => new Array<number>(n).fill(0);

  const plan = weeks.map((w) => {
    const mean = zeros();
    const sd = zeros();
    const plays = new Array<boolean>(n).fill(false);
    teams.forEach((t, i) => {
      const d = w.scores.get(t.roster_id);
      if (!d) return;
      plays[i] = true;
      mean[i] = d.mean;
      sd[i] = Math.sqrt(Math.max(0, d.variance));
    });
    let pairs: [number, number][] | null = null;
    if (w.pairs) {
      pairs = [];
      for (const [a, b] of w.pairs) {
        const ia = idx.get(a);
        const ib = idx.get(b);
        if (ia !== undefined && ib !== undefined && ia !== ib) pairs.push([ia, ib]);
      }
    }
    return { week: w.week, projected: w.projected, mean, sd, plays, pairs };
  });

  // Each team's projection error scales with its average projected weekly score.
  const errorScale = zeros();
  const projectedWeeks = plan.filter((w) => w.projected);
  for (const w of projectedWeeks) {
    for (let i = 0; i < n; i++) errorScale[i] = errorScale[i]! + (w.mean[i]! * teamError) / projectedWeeks.length;
  }

  const rng = mulberry32(options.seed);
  const normal = normalSampler(rng);

  const playoffs = zeros();
  const bye = zeros();
  const top = zeros();
  const seedSum = zeros();
  const winSum = zeros();
  const lossSum = zeros();
  const tieSum = zeros();

  const wins = zeros();
  const losses = zeros();
  const ties = zeros();
  const pf = zeros();
  const score = zeros();
  const shock = zeros();
  const order = teams.map((_, i) => i);

  const record = (i: number, result: number) => {
    if (result === 1) wins[i] = wins[i]! + 1;
    else if (result === 0) losses[i] = losses[i]! + 1;
    else ties[i] = ties[i]! + 1;
  };

  const focus = options.focusRosterId === undefined ? undefined : idx.get(options.focusRosterId);
  const firstWeek = plan[0];
  const firstPair = focus !== undefined ? firstWeek?.pairs?.find(([a, b]) => a === focus || b === focus) : undefined;
  let firstGames = 0;
  let firstWins = 0;
  let ifWin = 0;
  let ifWinMade = 0;
  let ifLoss = 0;
  let ifLossMade = 0;
  const byWins = new Map<number, { n: number; made: number }>();

  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) {
      const t = teams[i]!;
      wins[i] = t.wins;
      losses[i] = t.losses;
      ties[i] = t.ties;
      pf[i] = t.points_for;
      shock[i] = errorScale[i]! * normal();
    }

    let focusFirst: number | null = null;
    for (let wi = 0; wi < plan.length; wi++) {
      const w = plan[wi]!;
      const playing: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!w.plays[i]) continue;
        const x = Math.max(0, w.mean[i]! + (w.projected ? shock[i]! : 0) + w.sd[i]! * normal());
        score[i] = x;
        pf[i] = pf[i]! + x;
        playing.push(i);
      }
      for (const [a, b] of w.pairs ?? randomPairs(playing, rng)) {
        if (!w.plays[a] || !w.plays[b]) continue;
        const result = score[a]! > score[b]! ? 1 : score[a]! < score[b]! ? 0 : 0.5;
        record(a, result);
        record(b, 1 - result);
        if (wi === 0 && focus !== undefined) {
          if (a === focus) focusFirst = result;
          else if (b === focus) focusFirst = 1 - result;
        }
      }
      if (options.medianGame && playing.length > 1) {
        const ranked = [...playing].sort((x, y) => score[y]! - score[x]!);
        const winners = Math.floor(ranked.length / 2);
        ranked.forEach((i, rank) => record(i, rank < winners ? 1 : 0));
      }
    }

    order.sort(
      (x, y) => wins[y]! + ties[y]! / 2 - (wins[x]! + ties[x]! / 2) || pf[y]! - pf[x]! || teams[x]!.roster_id - teams[y]!.roster_id,
    );
    for (let rank = 0; rank < n; rank++) {
      const i = order[rank]!;
      seedSum[i] = seedSum[i]! + rank + 1;
      if (rank < playoffTeams) playoffs[i] = playoffs[i]! + 1;
      if (rank < byes) bye[i] = bye[i]! + 1;
      if (rank === 0) top[i] = top[i]! + 1;
      winSum[i] = winSum[i]! + wins[i]!;
      lossSum[i] = lossSum[i]! + losses[i]!;
      tieSum[i] = tieSum[i]! + ties[i]!;
    }

    if (focus !== undefined) {
      const made = order.indexOf(focus) < playoffTeams ? 1 : 0;
      const total = wins[focus]! + ties[focus]! / 2;
      const entry = byWins.get(total) ?? { n: 0, made: 0 };
      entry.n++;
      entry.made += made;
      byWins.set(total, entry);
      if (focusFirst !== null) {
        firstGames++;
        firstWins += focusFirst;
        if (focusFirst === 1) {
          ifWin++;
          ifWinMade += made;
        } else if (focusFirst === 0) {
          ifLoss++;
          ifLossMade += made;
        }
      }
    }
  }

  const results: SimTeamResult[] = teams.map((t, i) => ({
    roster_id: t.roster_id,
    playoffs: playoffs[i]! / sims,
    bye: bye[i]! / sims,
    top_seed: top[i]! / sims,
    avg_seed: seedSum[i]! / sims,
    avg_wins: winSum[i]! / sims,
    avg_losses: lossSum[i]! / sims,
    avg_ties: tieSum[i]! / sims,
  }));

  let focusResult: SimFocus | null = null;
  if (focus !== undefined) {
    const opponent = firstPair ? (firstPair[0] === focus ? firstPair[1] : firstPair[0]) : undefined;
    focusResult = {
      roster_id: teams[focus]!.roster_id,
      playoffs: playoffs[focus]! / sims,
      first_week:
        firstWeek && firstGames > 0
          ? {
              week: firstWeek.week,
              opponent: opponent === undefined ? null : teams[opponent]!.roster_id,
              win: firstWins / firstGames,
              playoffs_if_win: ifWin ? ifWinMade / ifWin : null,
              playoffs_if_loss: ifLoss ? ifLossMade / ifLoss : null,
            }
          : null,
      by_final_wins: [...byWins.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([w, e]) => ({ wins: w, share: e.n / sims, playoffs: e.made / e.n })),
    };
  }

  return { simulations: sims, teams: results, focus: focusResult };
}

function randomPairs(players: readonly number[], rng: () => number): [number, number][] {
  const a = [...players];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < a.length; i += 2) pairs.push([a[i]!, a[i + 1]!]);
  return pairs;
}
