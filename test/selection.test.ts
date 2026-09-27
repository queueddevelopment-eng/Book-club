import { describe, expect, it } from 'vitest';
import { readFactor, resolveMethod, select, type SelectionInput } from '../src/selection';

const base: SelectionInput = {
  candidates: [
    { bookId: 1, title: 'A', readCount: 0 },
    { bookId: 2, title: 'B', readCount: 0 },
    { bookId: 3, title: 'C', readCount: 0 },
  ],
  memberCount: 4,
  readPenalty: 0.5,
  rankings: [],
  approvals: [],
};

describe('readFactor', () => {
  it('scales with the share of members who have read the book', () => {
    expect(readFactor(0, 4, 0.5)).toBe(1);
    expect(readFactor(2, 4, 0.5)).toBe(0.75);
    expect(readFactor(4, 4, 0.5)).toBe(0.5);
    expect(readFactor(4, 4, 1)).toBe(0);
    expect(readFactor(3, 0, 0.5)).toBe(1);
  });
});

describe('resolveMethod', () => {
  it('takes the plurality and falls back on ties or no votes', () => {
    expect(resolveMethod([])).toBe('ranked');
    expect(resolveMethod(['random', 'random', 'approval'])).toBe('random');
    expect(resolveMethod(['random', 'approval'])).toBe('ranked');
  });
});

describe('select', () => {
  it('ranked: Borda count picks the consensus book', () => {
    const r = select('ranked', {
      ...base,
      rankings: [
        { memberId: 1, bookId: 1, position: 1 }, { memberId: 1, bookId: 2, position: 2 }, { memberId: 1, bookId: 3, position: 3 },
        { memberId: 2, bookId: 3, position: 1 }, { memberId: 2, bookId: 2, position: 2 }, { memberId: 2, bookId: 1, position: 3 },
        { memberId: 3, bookId: 2, position: 1 }, { memberId: 3, bookId: 1, position: 2 },
      ],
    });
    // A: 3+1+2=6, B: 2+2+3=7, C: 1+3=4
    expect(r.winnerBookId).toBe(2);
    expect(r.ballots).toBe(3);
    expect(r.scores.map((s) => s.rawScore)).toEqual([7, 6, 4]);
  });

  it('already-read penalty can flip the winner', () => {
    const input: SelectionInput = {
      ...base,
      candidates: [
        { bookId: 1, title: 'A', readCount: 4 },
        { bookId: 2, title: 'B', readCount: 0 },
        { bookId: 3, title: 'C', readCount: 0 },
      ],
      approvals: [
        { memberId: 1, bookId: 1 }, { memberId: 2, bookId: 1 }, { memberId: 3, bookId: 1 },
        { memberId: 1, bookId: 2 }, { memberId: 2, bookId: 2 },
      ],
    };
    const r = select('approval', input);
    expect(r.winnerBookId).toBe(2); // A: 3 * 0.5 = 1.5 < B: 2
  });

  it('ignores ballots for books that are no longer candidates', () => {
    const r = select('approval', { ...base, approvals: [{ memberId: 1, bookId: 99 }, { memberId: 1, bookId: 3 }] });
    expect(r.winnerBookId).toBe(3);
  });

  it('breaks ties randomly and reports it', () => {
    const r = select('approval', { ...base, approvals: [{ memberId: 1, bookId: 1 }, { memberId: 2, bookId: 2 }] }, () => 0.99);
    expect(r.tiebreak).toBe(true);
    expect(r.winnerBookId).toBe(2);
  });

  it('random: weights draws by the read penalty', () => {
    const input: SelectionInput = {
      ...base,
      candidates: [
        { bookId: 1, title: 'A', readCount: 4 }, // weight 0.5
        { bookId: 2, title: 'B', readCount: 0 }, // weight 1
      ],
    };
    const low = select('random', input, () => 0.1);
    const high = select('random', input, () => 0.5);
    expect(low.winnerBookId).toBe(1);
    expect(high.winnerBookId).toBe(2);
    expect(low.scores.find((s) => s.bookId === 1)!.chance).toBeCloseTo(1 / 3, 2);
  });

  it('random: a total penalty still leaves a draw possible when every book is read', () => {
    const input: SelectionInput = { ...base, readPenalty: 1, candidates: [{ bookId: 1, title: 'A', readCount: 4 }] };
    expect(select('random', input).winnerBookId).toBe(1);
  });

  it('throws with no candidates', () => {
    expect(() => select('ranked', { ...base, candidates: [] })).toThrow();
  });
});
