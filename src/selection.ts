// Pure selection logic, kept free of I/O so it can be unit tested.

export type Method = 'ranked' | 'approval' | 'random';
export const METHODS: Method[] = ['ranked', 'approval', 'random'];

export interface Candidate {
  bookId: number;
  title: string;
  readCount: number; // members who have already read it
}

export interface SelectionInput {
  candidates: Candidate[];
  memberCount: number;
  readPenalty: number; // 0..1
  rankings: { memberId: number; bookId: number; position: number }[];
  approvals: { memberId: number; bookId: number }[];
}

export interface ScoredCandidate {
  bookId: number;
  title: string;
  rawScore: number; // Borda points, approval count, or 1 for random
  readFactor: number; // multiplier from the already-read penalty
  score: number; // rawScore * readFactor (for random, this is the weight)
  chance?: number; // random only: probability of being picked
}

export interface SelectionResult {
  method: Method;
  winnerBookId: number;
  scores: ScoredCandidate[];
  tiebreak: boolean;
  ballots: number;
}

/**
 * Multiplier applied to a book's score. A book nobody has read keeps its full
 * score; a book every member has read is scaled by (1 - readPenalty).
 */
export function readFactor(readCount: number, memberCount: number, readPenalty: number): number {
  if (memberCount <= 0) return 1;
  const fraction = Math.min(1, Math.max(0, readCount / memberCount));
  const penalty = Math.min(1, Math.max(0, readPenalty));
  return 1 - penalty * fraction;
}

/** Plurality of members' method preferences; ties and no votes fall back to ranked. */
export function resolveMethod(votes: Method[], fallback: Method = 'ranked'): Method {
  const counts = new Map<Method, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: Method = fallback;
  let bestCount = 0;
  let tied = false;
  for (const m of METHODS) {
    const c = counts.get(m) ?? 0;
    if (c > bestCount) {
      best = m;
      bestCount = c;
      tied = false;
    } else if (c === bestCount && c > 0) {
      tied = true;
    }
  }
  return bestCount === 0 || tied ? fallback : best;
}

export function select(method: Method, input: SelectionInput, rng: () => number = Math.random): SelectionResult {
  if (input.candidates.length === 0) throw new Error('No books have been suggested yet');
  const candidateIds = new Set(input.candidates.map((c) => c.bookId));
  const raw = new Map<number, number>(input.candidates.map((c) => [c.bookId, 0]));
  const voters = new Set<number>();

  if (method === 'ranked') {
    // Borda count: with n candidates, 1st place earns n points, 2nd n-1, ... Unranked books earn 0.
    const n = input.candidates.length;
    const byMember = new Map<number, { bookId: number; position: number }[]>();
    for (const r of input.rankings) {
      if (!candidateIds.has(r.bookId)) continue;
      const list = byMember.get(r.memberId) ?? [];
      list.push(r);
      byMember.set(r.memberId, list);
    }
    for (const [memberId, list] of byMember) {
      voters.add(memberId);
      list.sort((a, b) => a.position - b.position);
      list.forEach((r, i) => raw.set(r.bookId, raw.get(r.bookId)! + (n - i)));
    }
  } else if (method === 'approval') {
    for (const a of input.approvals) {
      if (!candidateIds.has(a.bookId)) continue;
      voters.add(a.memberId);
      raw.set(a.bookId, raw.get(a.bookId)! + 1);
    }
  } else {
    for (const id of candidateIds) raw.set(id, 1);
  }

  const scores: ScoredCandidate[] = input.candidates.map((c) => {
    const factor = readFactor(c.readCount, input.memberCount, input.readPenalty);
    const rawScore = raw.get(c.bookId)!;
    // Random draws keep a small floor so a fully-penalised book is unlikely but still possible
    // unless the penalty is total.
    const score = method === 'random' ? Math.max(factor, input.readPenalty >= 1 ? 0 : 0.05) : rawScore * factor;
    return { bookId: c.bookId, title: c.title, rawScore, readFactor: round(factor), score: round(score) };
  });

  let winner: ScoredCandidate;
  let tiebreak = false;
  if (method === 'random') {
    let total = scores.reduce((s, c) => s + c.score, 0);
    if (total <= 0) {
      // Every book fully penalised: fall back to a uniform draw.
      scores.forEach((c) => (c.score = 1));
      total = scores.length;
    }
    scores.forEach((c) => (c.chance = round(c.score / total)));
    let r = rng() * total;
    winner = scores[scores.length - 1];
    for (const c of scores) {
      r -= c.score;
      if (r < 0) {
        winner = c;
        break;
      }
    }
  } else {
    const top = Math.max(...scores.map((c) => c.score));
    const leaders = scores.filter((c) => c.score === top);
    tiebreak = leaders.length > 1;
    winner = leaders[Math.floor(rng() * leaders.length)];
  }

  scores.sort((a, b) => b.score - a.score);
  return { method, winnerBookId: winner.bookId, scores, tiebreak, ballots: voters.size };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
