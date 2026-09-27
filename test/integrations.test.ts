import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBookDetails, searchBooks, storeLinks, stripHtml } from '../src/metadata';
import { generateTalkingPoints } from '../src/talking-points';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('metadata', () => {
  it('maps Google Books results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      items: [{
        id: 'abc',
        volumeInfo: {
          title: 'Project Hail Mary', authors: ['Andy Weir'], publishedDate: '2021-05-04', pageCount: 496,
          imageLinks: { thumbnail: 'http://books.google.com/x?id=abc&edge=curl' },
          industryIdentifiers: [{ type: 'ISBN_10', identifier: '0593135202' }, { type: 'ISBN_13', identifier: '9780593135204' }],
        },
        searchInfo: { textSnippet: 'A lone <b>astronaut</b>' },
      }],
    })));
    const [r] = await searchBooks('hail mary');
    expect(r).toMatchObject({
      sourceId: 'google:abc', title: 'Project Hail Mary', authors: ['Andy Weir'], isbn: '9780593135204',
      coverUrl: 'https://books.google.com/x?id=abc', snippet: 'A lone astronaut', pageCount: 496,
    });
  });

  it('falls back to Open Library when Google Books is rate limited', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('googleapis')
        ? json({ error: 'quota' }, 429)
        : json({ docs: [{ key: '/works/OL1W', title: 'Circe', author_name: ['Madeline Miller'], cover_i: 42, first_publish_year: 2018 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [r] = await searchBooks('circe');
    expect(r).toMatchObject({ sourceId: 'ol:/works/OL1W', coverUrl: 'https://covers.openlibrary.org/b/id/42-L.jpg', published: '2018' });
  });

  it('loads details with an author bio from Wikipedia', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('googleapis')) return json({ id: 'abc', volumeInfo: { title: 'Circe', authors: ['Madeline Miller'], description: '<p>A witch.</p><p>Exiled.</p>' } });
      if (url.includes('wikipedia')) return json({ type: 'standard', description: 'American novelist', extract: 'Madeline Miller is an American novelist.', thumbnail: { source: 'https://img/x.jpg' } });
      return json({}, 404);
    }));
    const d = await getBookDetails('google:abc');
    expect(d?.description).toBe('A witch.\n\nExiled.');
    expect(d?.authorBio).toBe('Madeline Miller is an American novelist.');
    expect(d?.authorPhotoUrl).toBe('https://img/x.jpg');
  });

  it('rejects malformed Open Library keys', async () => {
    expect(await getBookDetails('ol:/../../etc')).toBeNull();
  });

  it('builds store search links and strips HTML', () => {
    expect(storeLinks('Dune', 'Frank Herbert, Someone').audible).toBe('https://www.audible.com/search?keywords=Dune%20Frank%20Herbert');
    expect(stripHtml('a &amp; <i>b</i>')).toBe('a & b');
  });
});

describe('talking points', () => {
  const points = {
    overview: 'o', themes: ['grief'], icebreaker: 'i',
    questions: [{ category: 'Characters', question: 'Why does Circe stay on Aiaia?', why: 'agency' }],
  };

  it('calls Claude with structured output and fallbacks, and parses the result', async () => {
    let sent: any;
    let headers: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      headers = new Headers(init.headers);
      return json({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(points) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }));
    const r = await generateTalkingPoints({ ANTHROPIC_API_KEY: 'sk-test' }, { title: 'Circe', authors: 'Madeline Miller' }, ['- Bob (5/5): loved it']);
    expect(r.points).toEqual(points);
    expect(sent.model).toBe('claude-opus-5');
    expect(sent.fallbacks).toBe('default');
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(headers?.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(sent.messages[0].content).toContain('Bob (5/5)');
  });

  it('surfaces refusals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'refusal',
      content: [], usage: { input_tokens: 1, output_tokens: 0 },
    })));
    await expect(generateTalkingPoints({ ANTHROPIC_API_KEY: 'k' }, { title: 'x', authors: 'y' }, [])).rejects.toThrow(/declined/);
  });

  it('sends the workspace header, and falls back to Workers AI when Claude fails', async () => {
    let headers: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      headers = new Headers(init.headers);
      return json({ type: 'error', error: { type: 'invalid_request_error', message: 'bad key' } }, 400);
    }));
    const ai = { run: vi.fn(async () => ({ response: JSON.stringify(points) })) };
    const r = await generateTalkingPoints(
      { ANTHROPIC_API_KEY: 'k', ANTHROPIC_WORKSPACE_ID: 'wrkspc_1', AI: ai as any },
      { title: 'Circe', authors: 'Madeline Miller' },
      [],
    );
    expect(headers?.get('anthropic-workspace-id')).toBe('wrkspc_1');
    expect(r.model).toContain('llama');
  });

  it('uses Workers AI when there is no Anthropic key', async () => {
    const ai = { run: vi.fn(async () => ({ response: `Sure! ${JSON.stringify(points)}` })) };
    const r = await generateTalkingPoints({ AI: ai as any }, { title: 'Circe', authors: 'Madeline Miller' }, []);
    expect(r.points.questions).toHaveLength(1);
    expect(r.model).toContain('llama');
  });

  it('errors clearly when nothing is configured', async () => {
    await expect(generateTalkingPoints({}, { title: 'x', authors: 'y' }, [])).rejects.toThrow(/No LLM configured/);
  });
});
