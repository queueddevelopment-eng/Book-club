import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashPin, randomToken, requireMember, SESSION_COOKIE, timingSafeEqual } from './auth';
import { getBookDetails, searchBooks, storeLinks } from './metadata';
import { METHODS, resolveMethod, select, type Method } from './selection';
import { generateTalkingPoints } from './talking-points';
import type { AppEnv, Env } from './types';

const app = new Hono<AppEnv>();

// Tell the frontend which deploy answered, so a tab left open across an update can reload itself.
app.use('/api/*', async (c, next) => {
  await next();
  const version = c.env.CF_VERSION_METADATA?.id;
  if (version) c.header('X-App-Version', version);
});

class HttpError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err.message || 'Something went wrong' }, 500);
});

function readPenalty(env: Env): number {
  const n = Number(env.READ_PENALTY ?? '0.5');
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

function intParam(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
}

function text(v: unknown, max = 5000): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// ---------------------------------------------------------------- auth

app.get('/api/config', (c) =>
  c.json({
    clubName: c.env.CLUB_NAME || 'Book Club',
    passcodeRequired: !!c.env.CLUB_PASSCODE,
    readPenalty: readPenalty(c.env),
    llm: c.env.ANTHROPIC_API_KEY ? 'claude' : c.env.AI ? 'workers-ai' : null,
  }),
);

app.post('/api/join', async (c) => {
  const body = await c.req.json<{ name?: string; pin?: string; passcode?: string }>();
  const name = text(body.name, 40);
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!name) throw new HttpError(400, 'Please enter your name');
  if (pin.length < 4) throw new HttpError(400, 'Your PIN must be at least 4 characters');

  const existing = await c.env.DB.prepare('SELECT id, pin_hash, pin_salt FROM members WHERE name = ?')
    .bind(name)
    .first<{ id: number; pin_hash: string; pin_salt: string }>();

  let memberId: number;
  if (existing) {
    const { hash } = await hashPin(pin, existing.pin_salt);
    if (!timingSafeEqual(hash, existing.pin_hash)) throw new HttpError(403, 'That PIN does not match this name');
    memberId = existing.id;
  } else {
    if (c.env.CLUB_PASSCODE && !timingSafeEqual(String(body.passcode ?? ''), c.env.CLUB_PASSCODE)) {
      throw new HttpError(403, 'Wrong club passcode');
    }
    const { hash, salt } = await hashPin(pin);
    const row = await c.env.DB.prepare('INSERT INTO members (name, pin_hash, pin_salt) VALUES (?, ?, ?) RETURNING id')
      .bind(name, hash, salt)
      .first<{ id: number }>();
    memberId = row!.id;
  }

  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO sessions (token, member_id) VALUES (?, ?)').bind(token, memberId).run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 180,
  });
  return c.json({ member: { id: memberId, name } });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// Everything below requires a signed-in member.
app.use('/api/*', requireMember);

app.get('/api/me', (c) => c.json({ member: c.get('member') }));

app.get('/api/members', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.created_at,
       (SELECT COUNT(*) FROM reviews r WHERE r.member_id = m.id) AS review_count,
       (SELECT COUNT(*) FROM books b WHERE b.suggested_by = m.name COLLATE NOCASE) AS suggestion_count
     FROM members m ORDER BY m.name`,
  ).all();
  return c.json({ members: results });
});

// ---------------------------------------------------------------- books

app.get('/api/search', async (c) => {
  const q = text(c.req.query('q'), 200);
  if (!q) return c.json({ results: [] });
  return c.json({ results: await searchBooks(q, c.env.GOOGLE_BOOKS_API_KEY) });
});

app.post('/api/books', async (c) => {
  const body = await c.req.json<{ sourceId?: string; title?: string; authors?: string; suggestedBy?: string; pitch?: string }>();
  const member = c.get('member');
  const suggestedBy = text(body.suggestedBy, 60) ?? member.name;
  const pitch = text(body.pitch, 1000);

  if (body.sourceId) {
    const existing = await c.env.DB.prepare('SELECT id, in_pool, suggested_by FROM books WHERE source_id = ?')
      .bind(body.sourceId)
      .first<{ id: number; in_pool: number; suggested_by: string | null }>();
    if (existing?.in_pool) {
      throw new HttpError(409, `That book is already in the suggestions${existing.suggested_by ? ` (suggested by ${existing.suggested_by})` : ''}`);
    }
    if (existing) {
      // A book the club has read before, suggested again.
      await c.env.DB.prepare('UPDATE books SET in_pool = 1, suggested_by = ?, pitch = ? WHERE id = ?')
        .bind(suggestedBy, pitch, existing.id)
        .run();
      return c.json({ id: existing.id });
    }
    const d = await getBookDetails(body.sourceId, c.env.GOOGLE_BOOKS_API_KEY);
    if (!d) throw new HttpError(404, "Couldn't load that book's details — try again or add it manually");
    const row = await c.env.DB.prepare(
      `INSERT INTO books (title, authors, description, cover_url, published, page_count, isbn, categories,
         author_bio, author_photo_url, source_id, added_by, suggested_by, pitch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        d.title,
        d.authors.join(', '),
        d.description ?? null,
        d.coverUrl ?? null,
        d.published ?? null,
        d.pageCount ?? null,
        d.isbn ?? null,
        d.categories?.join(', ') ?? null,
        d.authorBio ?? null,
        d.authorPhotoUrl ?? null,
        d.sourceId,
        member.id,
        suggestedBy,
        pitch,
      )
      .first<{ id: number }>();
    return c.json({ id: row!.id });
  }

  const title = text(body.title, 300);
  if (!title) throw new HttpError(400, 'A title is required');
  const dupe = await c.env.DB.prepare('SELECT suggested_by FROM books WHERE in_pool = 1 AND title = ? COLLATE NOCASE')
    .bind(title)
    .first<{ suggested_by: string | null }>();
  if (dupe) throw new HttpError(409, `That book is already in the suggestions${dupe.suggested_by ? ` (suggested by ${dupe.suggested_by})` : ''}`);
  const row = await c.env.DB.prepare(
    'INSERT INTO books (title, authors, added_by, suggested_by, pitch) VALUES (?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(title, text(body.authors, 300) ?? '', member.id, suggestedBy, pitch)
    .first<{ id: number }>();
  return c.json({ id: row!.id });
});

app.get('/api/books', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.title, b.authors, b.cover_url, b.published, b.suggested_by, b.pitch, b.in_pool,
       (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.book_id = b.id) AS avg_rating,
       (SELECT COUNT(*) FROM reviews r WHERE r.book_id = b.id) AS review_count,
       (SELECT COUNT(*) FROM read_before rb WHERE rb.book_id = b.id) AS read_count,
       (SELECT GROUP_CONCAT(m.name, ', ') FROM read_before rb JOIN members m ON m.id = rb.member_id WHERE rb.book_id = b.id) AS read_by,
       EXISTS (SELECT 1 FROM read_before rb WHERE rb.book_id = b.id AND rb.member_id = ?) AS read_by_me,
       (SELECT MAX(meeting_date) FROM meetings m WHERE m.chosen_book_id = b.id) AS club_read_date,
       EXISTS (SELECT 1 FROM meetings m WHERE m.chosen_book_id = b.id) AS club_pick
     FROM books b ORDER BY b.in_pool DESC, b.created_at DESC`,
  )
    .bind(c.get('member').id)
    .all();
  return c.json({ books: results });
});

async function loadBook(env: Env, id: number) {
  const book = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(id).first<Record<string, any>>();
  if (!book) throw new HttpError(404, 'Book not found');
  return book;
}

app.get('/api/books/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  const me = c.get('member');
  const book = await loadBook(c.env, id);
  const [reviews, progress, readers, tp, meetings] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT r.member_id, m.name, r.rating, r.body, r.updated_at FROM reviews r JOIN members m ON m.id = r.member_id
       WHERE r.book_id = ? ORDER BY r.updated_at DESC`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT p.member_id, m.name, p.percent, p.format, p.note, p.updated_at FROM progress p JOIN members m ON m.id = p.member_id
       WHERE p.book_id = ? ORDER BY p.percent DESC`,
    ).bind(id),
    c.env.DB.prepare(
      'SELECT rb.member_id, m.name FROM read_before rb JOIN members m ON m.id = rb.member_id WHERE rb.book_id = ? ORDER BY m.name',
    ).bind(id),
    c.env.DB.prepare('SELECT content_json, model, created_at FROM talking_points WHERE book_id = ?').bind(id),
    c.env.DB.prepare(
      `SELECT DISTINCT mt.id, mt.title, mt.meeting_date, mt.status, mt.chosen_book_id = ? AS chosen
       FROM meetings mt LEFT JOIN suggestions s ON s.meeting_id = mt.id AND s.book_id = ?
       WHERE s.book_id IS NOT NULL OR mt.chosen_book_id = ? ORDER BY mt.meeting_date DESC`,
    ).bind(id, id, id),
  ]);
  const tpRow = tp.results[0] as { content_json: string; model: string; created_at: string } | undefined;
  const links = storeLinks(book.title, book.authors);
  return c.json({
    book: {
      ...book,
      club_pick: meetings.results.some((m: any) => m.chosen),
      audible_link: book.audible_url || links.audible,
      kindle_link: book.kindle_url || links.kindle,
    },
    reviews: reviews.results,
    progress: progress.results,
    readers: readers.results,
    readByMe: readers.results.some((r: any) => r.member_id === me.id),
    talkingPoints: tpRow ? { ...JSON.parse(tpRow.content_json), model: tpRow.model, created_at: tpRow.created_at } : null,
    meetings: meetings.results,
  });
});

app.patch('/api/books/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  await loadBook(c.env, id);
  const body = await c.req.json<Record<string, unknown>>();
  const url = (v: unknown) => {
    const t = text(v, 1000);
    if (t && !/^https:\/\//.test(t)) throw new HttpError(400, 'Links must start with https://');
    return t;
  };
  const fields: [string, unknown][] = [];
  if ('audible_url' in body) fields.push(['audible_url', url(body.audible_url)]);
  if ('kindle_url' in body) fields.push(['kindle_url', url(body.kindle_url)]);
  if ('cover_url' in body) fields.push(['cover_url', url(body.cover_url)]);
  if ('description' in body) fields.push(['description', text(body.description, 20000)]);
  if ('title' in body) {
    const t = text(body.title, 300);
    if (!t) throw new HttpError(400, 'Title cannot be empty');
    fields.push(['title', t]);
  }
  if ('authors' in body) fields.push(['authors', text(body.authors, 300) ?? '']);
  if ('suggested_by' in body) fields.push(['suggested_by', text(body.suggested_by, 60)]);
  if ('pitch' in body) fields.push(['pitch', text(body.pitch, 1000)]);
  if (!fields.length) return c.json({ ok: true });
  await c.env.DB.prepare(`UPDATE books SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...fields.map(([, v]) => v), id)
    .run();
  return c.json({ ok: true });
});

app.delete('/api/books/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  await loadBook(c.env, id);
  const picked = await c.env.DB.prepare('SELECT 1 FROM meetings WHERE chosen_book_id = ?').bind(id).first();
  if (picked) throw new HttpError(409, "This book was a club pick, so it stays in the club's history");
  await c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.put('/api/books/:id/read', async (c) => {
  const id = intParam(c.req.param('id'));
  await loadBook(c.env, id);
  const { read } = await c.req.json<{ read: boolean }>();
  const me = c.get('member').id;
  await c.env.DB.prepare(
    read
      ? 'INSERT OR IGNORE INTO read_before (book_id, member_id) VALUES (?, ?)'
      : 'DELETE FROM read_before WHERE book_id = ? AND member_id = ?',
  )
    .bind(id, me)
    .run();
  return c.json({ ok: true });
});

app.put('/api/books/:id/review', async (c) => {
  const id = intParam(c.req.param('id'));
  await loadBook(c.env, id);
  const body = await c.req.json<{ rating?: number; body?: string }>();
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Rating must be 1–5 stars');
  await c.env.DB.prepare(
    `INSERT INTO reviews (book_id, member_id, rating, body) VALUES (?, ?, ?, ?)
     ON CONFLICT (book_id, member_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = datetime('now')`,
  )
    .bind(id, c.get('member').id, rating, text(body.body, 10000))
    .run();
  return c.json({ ok: true });
});

app.delete('/api/books/:id/review', async (c) => {
  const id = intParam(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM reviews WHERE book_id = ? AND member_id = ?').bind(id, c.get('member').id).run();
  return c.json({ ok: true });
});

app.put('/api/books/:id/progress', async (c) => {
  const id = intParam(c.req.param('id'));
  await loadBook(c.env, id);
  const body = await c.req.json<{ percent?: number; format?: string; note?: string }>();
  const percent = Math.round(Number(body.percent));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new HttpError(400, 'Progress must be 0–100%');
  const format = ['print', 'kindle', 'audible', 'other'].includes(body.format ?? '') ? body.format : 'print';
  await c.env.DB.prepare(
    `INSERT INTO progress (book_id, member_id, percent, format, note) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (book_id, member_id) DO UPDATE SET percent = excluded.percent, format = excluded.format,
       note = excluded.note, updated_at = datetime('now')`,
  )
    .bind(id, c.get('member').id, percent, format, text(body.note, 280))
    .run();
  return c.json({ ok: true });
});

app.post('/api/books/:id/talking-points', async (c) => {
  const id = intParam(c.req.param('id'));
  const book = await loadBook(c.env, id);
  const { results: reviews } = await c.env.DB.prepare(
    `SELECT m.name, r.rating, r.body FROM reviews r JOIN members m ON m.id = r.member_id
     WHERE r.book_id = ? AND r.body IS NOT NULL ORDER BY r.updated_at DESC LIMIT 8`,
  )
    .bind(id)
    .all<{ name: string; rating: number; body: string }>();
  const { points, model } = await generateTalkingPoints(
    c.env,
    book as any,
    reviews.map((r) => `- ${r.name} (${r.rating}/5): ${r.body.slice(0, 500)}`),
  );
  await c.env.DB.prepare(
    `INSERT INTO talking_points (book_id, content_json, model, created_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (book_id) DO UPDATE SET content_json = excluded.content_json, model = excluded.model,
       created_by = excluded.created_by, created_at = datetime('now')`,
  )
    .bind(id, JSON.stringify(points), model, c.get('member').id)
    .run();
  return c.json({ talkingPoints: { ...points, model } });
});

// ---------------------------------------------------------------- meetings

app.get('/api/meetings', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT mt.id, mt.title, mt.meeting_date, mt.location, mt.status, mt.method, mt.chosen_book_id,
       b.title AS book_title, b.authors AS book_authors, b.cover_url AS book_cover,
       CASE WHEN mt.status = 'decided' THEN (SELECT COUNT(*) FROM suggestions s WHERE s.meeting_id = mt.id)
         ELSE (SELECT COUNT(*) FROM books WHERE in_pool = 1) END AS suggestion_count
     FROM meetings mt LEFT JOIN books b ON b.id = mt.chosen_book_id
     ORDER BY CASE WHEN mt.meeting_date IS NULL THEN 1 ELSE 0 END, mt.meeting_date DESC, mt.id DESC`,
  ).all();
  return c.json({ meetings: results });
});

app.post('/api/meetings', async (c) => {
  const body = await c.req.json<{ title?: string; meeting_date?: string; location?: string }>();
  const title = text(body.title, 200);
  if (!title) throw new HttpError(400, 'Give the meeting a name');
  const row = await c.env.DB.prepare(
    'INSERT INTO meetings (title, meeting_date, location, created_by) VALUES (?, ?, ?, ?) RETURNING id',
  )
    .bind(title, text(body.meeting_date, 40), text(body.location, 200), c.get('member').id)
    .first<{ id: number }>();
  return c.json({ id: row!.id });
});

async function loadMeeting(env: Env, id: number) {
  const m = await env.DB.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first<Record<string, any>>();
  if (!m) throw new HttpError(404, 'Meeting not found');
  return m;
}

// Candidates for an open meeting are the whole suggestion pool.
async function selectionInput(env: Env, meetingId: number) {
  const [cands, members, rankings, approvals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT b.id AS bookId, b.title, (SELECT COUNT(*) FROM read_before rb WHERE rb.book_id = b.id) AS readCount
       FROM books b WHERE b.in_pool = 1 ORDER BY b.created_at`,
    ),
    env.DB.prepare('SELECT COUNT(*) AS n FROM members'),
    env.DB.prepare('SELECT member_id AS memberId, book_id AS bookId, position FROM rankings WHERE meeting_id = ?').bind(meetingId),
    env.DB.prepare('SELECT member_id AS memberId, book_id AS bookId FROM approvals WHERE meeting_id = ?').bind(meetingId),
  ]);
  return {
    candidates: cands.results as any[],
    memberCount: (members.results[0] as any).n as number,
    readPenalty: readPenalty(env),
    rankings: rankings.results as any[],
    approvals: approvals.results as any[],
  };
}

app.get('/api/meetings/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  const me = c.get('member').id;
  const meeting = await loadMeeting(c.env, id);
  const bookCols = `b.id AS book_id, b.pitch, b.suggested_by, b.title, b.authors, b.cover_url, b.published,
         b.page_count, b.description,
         (SELECT COUNT(*) FROM read_before rb WHERE rb.book_id = b.id) AS read_count,
         (SELECT GROUP_CONCAT(m2.name, ', ') FROM read_before rb JOIN members m2 ON m2.id = rb.member_id WHERE rb.book_id = b.id) AS read_by,
         EXISTS (SELECT 1 FROM read_before rb WHERE rb.book_id = b.id AND rb.member_id = ?) AS read_by_me`;
  const [suggestions, methodVotes, myRanking, myApprovals, voters] = await c.env.DB.batch([
    // Open meetings choose from the suggestion pool; decided ones keep a snapshot of what was on the ballot.
    meeting.status === 'decided'
      ? c.env.DB.prepare(
          `SELECT ${bookCols} FROM suggestions s JOIN books b ON b.id = s.book_id WHERE s.meeting_id = ? ORDER BY s.created_at`,
        ).bind(me, id)
      : c.env.DB.prepare(`SELECT ${bookCols} FROM books b WHERE b.in_pool = 1 ORDER BY b.created_at`).bind(me),
    c.env.DB.prepare(
      'SELECT mv.method, mv.member_id, m.name FROM method_votes mv JOIN members m ON m.id = mv.member_id WHERE mv.meeting_id = ?',
    ).bind(id),
    c.env.DB.prepare('SELECT book_id FROM rankings WHERE meeting_id = ? AND member_id = ? ORDER BY position').bind(id, me),
    c.env.DB.prepare('SELECT book_id FROM approvals WHERE meeting_id = ? AND member_id = ?').bind(id, me),
    c.env.DB.prepare(
      `SELECT DISTINCT m.name, 'ranked' AS kind FROM rankings r JOIN members m ON m.id = r.member_id WHERE r.meeting_id = ?
       UNION SELECT DISTINCT m.name, 'approval' FROM approvals a JOIN members m ON m.id = a.member_id WHERE a.meeting_id = ?`,
    ).bind(id, id),
  ]);

  const votes = methodVotes.results as { method: Method; member_id: number; name: string }[];
  const effectiveMethod = meeting.method ?? resolveMethod(votes.map((v) => v.method));

  // Live standings for the vote-based methods (random has nothing to show until the draw).
  let standings = null;
  if (meeting.status !== 'decided' && suggestions.results.length > 0 && effectiveMethod !== 'random') {
    const input = await selectionInput(c.env, id);
    standings = select(effectiveMethod, input, () => 0).scores;
  }

  return c.json({
    meeting: { ...meeting, result: meeting.result_json ? JSON.parse(meeting.result_json) : null, result_json: undefined },
    suggestions: suggestions.results,
    methodVotes: votes,
    myMethod: votes.find((v) => v.member_id === me)?.method ?? null,
    effectiveMethod,
    myRanking: myRanking.results.map((r: any) => r.book_id),
    myApprovals: myApprovals.results.map((r: any) => r.book_id),
    voters: voters.results,
    standings,
  });
});

app.patch('/api/meetings/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  const meeting = await loadMeeting(c.env, id);
  const body = await c.req.json<Record<string, unknown>>();
  const fields: [string, unknown][] = [];
  if ('title' in body) {
    const t = text(body.title, 200);
    if (!t) throw new HttpError(400, 'Title cannot be empty');
    fields.push(['title', t]);
  }
  if ('meeting_date' in body) fields.push(['meeting_date', text(body.meeting_date, 40)]);
  if ('location' in body) fields.push(['location', text(body.location, 200)]);
  if ('status' in body) {
    const status = body.status;
    if (status !== 'suggesting' && status !== 'voting') throw new HttpError(400, 'Use "Pick the book" to decide');
    fields.push(['status', status]);
    if (meeting.status === 'decided') {
      // Re-opening a decided meeting clears the result and puts the pick back in the pool.
      fields.push(['chosen_book_id', null], ['result_json', null], ['method', null]);
    }
  }
  if (!fields.length) return c.json({ ok: true });
  const reopening = meeting.status === 'decided' && 'status' in body;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE meetings SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...fields.map(([, v]) => v), id),
    ...(reopening
      ? [
          c.env.DB.prepare('UPDATE books SET in_pool = 1 WHERE id = ?').bind(meeting.chosen_book_id),
          c.env.DB.prepare('DELETE FROM suggestions WHERE meeting_id = ?').bind(id),
        ]
      : []),
  ]);
  return c.json({ ok: true });
});

app.delete('/api/meetings/:id', async (c) => {
  const id = intParam(c.req.param('id'));
  const meeting = await loadMeeting(c.env, id);
  if (meeting.created_by && meeting.created_by !== c.get('member').id) {
    throw new HttpError(403, 'Only the person who created this meeting can delete it');
  }
  await c.env.DB.prepare('DELETE FROM meetings WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.put('/api/meetings/:id/method', async (c) => {
  const id = intParam(c.req.param('id'));
  const meeting = await loadMeeting(c.env, id);
  if (meeting.status === 'decided') throw new HttpError(409, 'This meeting has already picked its book');
  const { method } = await c.req.json<{ method: Method | null }>();
  const me = c.get('member').id;
  if (method === null) {
    await c.env.DB.prepare('DELETE FROM method_votes WHERE meeting_id = ? AND member_id = ?').bind(id, me).run();
  } else {
    if (!METHODS.includes(method)) throw new HttpError(400, 'Unknown method');
    await c.env.DB.prepare(
      `INSERT INTO method_votes (meeting_id, member_id, method) VALUES (?, ?, ?)
       ON CONFLICT (meeting_id, member_id) DO UPDATE SET method = excluded.method`,
    )
      .bind(id, me, method)
      .run();
  }
  return c.json({ ok: true });
});

async function poolIds(env: Env): Promise<Set<number>> {
  const { results } = await env.DB.prepare('SELECT id AS book_id FROM books WHERE in_pool = 1').all<{ book_id: number }>();
  return new Set(results.map((r) => r.book_id));
}

async function parseBallot(c: any, id: number): Promise<number[]> {
  const meeting = await loadMeeting(c.env, id);
  if (meeting.status === 'decided') throw new HttpError(409, 'Voting has closed for this meeting');
  const { bookIds } = await c.req.json();
  if (!Array.isArray(bookIds)) throw new HttpError(400, 'bookIds must be a list');
  const valid = await poolIds(c.env);
  const ids = [...new Set(bookIds.map(Number))];
  if (ids.some((b) => !valid.has(b))) throw new HttpError(400, 'Ballot includes a book that is no longer in the suggestions');
  return ids;
}

app.put('/api/meetings/:id/ranking', async (c) => {
  const id = intParam(c.req.param('id'));
  const ids = await parseBallot(c, id);
  const me = c.get('member').id;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM rankings WHERE meeting_id = ? AND member_id = ?').bind(id, me),
    ...ids.map((bookId, i) =>
      c.env.DB.prepare('INSERT INTO rankings (meeting_id, member_id, book_id, position) VALUES (?, ?, ?, ?)').bind(id, me, bookId, i + 1),
    ),
  ]);
  return c.json({ ok: true });
});

app.put('/api/meetings/:id/approvals', async (c) => {
  const id = intParam(c.req.param('id'));
  const ids = await parseBallot(c, id);
  const me = c.get('member').id;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM approvals WHERE meeting_id = ? AND member_id = ?').bind(id, me),
    ...ids.map((bookId) => c.env.DB.prepare('INSERT INTO approvals (meeting_id, member_id, book_id) VALUES (?, ?, ?)').bind(id, me, bookId)),
  ]);
  return c.json({ ok: true });
});

app.post('/api/meetings/:id/decide', async (c) => {
  const id = intParam(c.req.param('id'));
  const meeting = await loadMeeting(c.env, id);
  if (meeting.status === 'decided') throw new HttpError(409, 'This meeting has already picked its book');
  const body = await c.req.json<{ method?: Method }>().catch(() => ({}) as { method?: Method });
  let method: Method;
  if (body.method) {
    if (!METHODS.includes(body.method)) throw new HttpError(400, 'Unknown method');
    method = body.method;
  } else {
    const { results } = await c.env.DB.prepare('SELECT method FROM method_votes WHERE meeting_id = ?').bind(id).all<{ method: Method }>();
    method = resolveMethod(results.map((r) => r.method));
  }
  const input = await selectionInput(c.env, id);
  if (input.candidates.length === 0) throw new HttpError(400, 'Suggest at least one book first');
  const result = select(method, input);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM suggestions WHERE meeting_id = ?').bind(id),
    c.env.DB.prepare(
      'INSERT INTO suggestions (meeting_id, book_id, member_id, pitch) SELECT ?, id, added_by, pitch FROM books WHERE in_pool = 1',
    ).bind(id),
    c.env.DB.prepare('UPDATE books SET in_pool = 0 WHERE id = ?').bind(result.winnerBookId),
    c.env.DB.prepare("UPDATE meetings SET status = 'decided', method = ?, chosen_book_id = ?, result_json = ? WHERE id = ?").bind(
      method,
      result.winnerBookId,
      JSON.stringify({ ...result, decidedBy: c.get('member').name, decidedAt: new Date().toISOString() }),
      id,
    ),
  ]);
  return c.json({ result });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export default app;
