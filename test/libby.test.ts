import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAvailability, findLibraries, getLibrary, pickMatches, searchUrl, waitDays } from '../src/libby';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const item = (over: Record<string, unknown>) => ({
  id: '1', title: 'Circe', type: { id: 'ebook' }, creators: [{ name: 'Madeline Miller', role: 'Author' }],
  isOwned: true, isAvailable: false, ownedCopies: 4, availableCopies: 0, holdsCount: 10, ...over,
});

describe('waitDays', () => {
  it('uses Libby’s estimate, zero when available, or a 14-day-loan estimate', () => {
    expect(waitDays(item({ estimatedWaitDays: 21 }))).toBe(21);
    expect(waitDays(item({ isAvailable: true, estimatedWaitDays: 21 }))).toBe(0);
    expect(waitDays(item({}))).toBe(42); // ceil(11 / 4) = 3 loan periods
    expect(waitDays(item({ ownedCopies: 0 }))).toBeNull();
  });
});

describe('pickMatches', () => {
  it('keeps the soonest ebook and audiobook edition for the right author', () => {
    const r = pickMatches(
      [
        item({ id: 'e1', estimatedWaitDays: 60 }),
        item({ id: 'e2', title: 'Circe (Movie Tie-In)', estimatedWaitDays: 7 }),
        item({ id: 'a1', type: { id: 'audiobook' }, isAvailable: true, availableCopies: 1 }),
        item({ id: 'x1', creators: [{ name: 'Someone Else' }] }),
        item({ id: 'x2', title: 'Circe Study Guide' }),
        item({ id: 'x3', type: { id: 'magazine' } }),
      ],
      'Circe',
      'Madeline Miller',
      'lapl',
    );
    expect(r.map((f) => [f.format, f.titleId, f.estimatedWaitDays])).toEqual([['ebook', 'e2', 7], ['audiobook', 'a1', 0]]);
    expect(r[0].url).toBe('https://libbyapp.com/library/lapl/everything/page-1/e2');
  });

  it('ignores subtitles, leading articles and accents when matching titles', () => {
    const r = pickMatches([item({ title: 'The Name of the Wind', creators: [{ name: 'Patrick Rothfuss' }] })], 'Name of the Wind: 10th Anniversary', 'Patrick Rothfuss', 'x');
    expect(r).toHaveLength(1);
  });
});

describe('network calls', () => {
  it('queries the library catalogue and reports failures as null', async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ items: [item({ estimatedWaitDays: 14 })] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await checkAvailability('lapl', 'Circe: A Novel', 'Madeline Miller');
    expect(r?.[0].estimatedWaitDays).toBe(14);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://thunder.api.overdrive.com/v2/libraries/lapl/media?query=circe%20Madeline%20Miller&perPage=24',
    );
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    expect(await checkAvailability('lapl', 'Circe', 'Madeline Miller')).toBeNull();
    expect(await checkAvailability('../evil', 'Circe', 'x')).toBeNull();
  });

  it('finds libraries and de-duplicates systems across branches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      branches: [
        { systems: [{ fulfillmentId: 'spl', name: 'Seattle Public Library' }] },
        { systems: [{ fulfillmentId: 'spl', name: 'Seattle Public Library' }, { fulfillmentId: 'kcls', name: 'King County Library System' }] },
        { systems: [{ name: 'No key' }] },
      ],
    })));
    expect(await findLibraries('seattle')).toEqual([
      { key: 'spl', name: 'Seattle Public Library' },
      { key: 'kcls', name: 'King County Library System' },
    ]);
  });

  it('validates a library key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ name: 'Los Angeles Public Library', preferredKey: 'lapl' })));
    expect(await getLibrary('LAPL')).toEqual({ key: 'lapl', name: 'Los Angeles Public Library' });
    expect(await getLibrary('not a key!')).toBeNull();
  });
});

it('builds search links', () => {
  expect(searchUrl('lapl', 'Circe: A Novel', 'Madeline Miller')).toBe('https://libbyapp.com/search/lapl/search/query-Circe%20Madeline%20Miller/page-1');
  expect(searchUrl(null, 'Circe', 'x')).toBe('https://libbyapp.com/interview/welcome');
});
