// Book Club single-page app. Plain ES modules, no build step.

const app = document.getElementById('app');
let config = { clubName: 'Book Club', passcodeRequired: false, readPenalty: 0.5, llm: null };
let me = null;

// ------------------------------------------------------------ helpers

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let appVersion = null;
let reloading = false;

/** Reloads the page once the server reports a newer deploy than the one this tab loaded. */
function checkVersion(res) {
  const v = res.headers.get('X-App-Version');
  if (!v) return;
  if (!appVersion) appVersion = v;
  else if (v !== appVersion && !reloading) {
    reloading = true;
    toast('The app was just updated — reloading…');
    setTimeout(() => location.reload(), 1200);
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  checkVersion(res);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/join') {
    me = null;
    location.hash = '#/login';
    throw new Error('Please sign in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

/** Wrap an async click/submit handler with error toasts and a disabled button while it runs. */
function action(fn) {
  return async (e) => {
    e?.preventDefault?.();
    const btn = e?.submitter || (e?.currentTarget instanceof HTMLButtonElement ? e.currentTarget : null);
    if (btn) btn.disabled = true;
    try {
      await fn(e);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
const on = (sel, ev, fn, root = app) => $$(sel, root).forEach((el) => el.addEventListener(ev, fn));

function cover(book, size = '') {
  const url = book.cover_url ?? book.coverUrl ?? book.book_cover;
  const title = book.title ?? book.book_title ?? '';
  return url
    ? `<img class="cover ${size}" src="${esc(url)}" alt="Cover of ${esc(title)}" loading="lazy" />`
    : `<div class="cover ${size}">${esc(title)}</div>`;
}

function stars(n) {
  const r = Math.round(Number(n) || 0);
  return `<span class="stars" aria-label="${r} out of 5 stars">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span>`;
}

function fmtDate(d) {
  if (!d) return 'Date TBD';
  const date = new Date(`${d}T12:00:00`);
  if (isNaN(date)) return d;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(`${ts.replace(' ', 'T')}Z`).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const METHOD_INFO = {
  ranked: { name: 'Ranked choice', icon: '🏆', blurb: 'Everyone orders the books. Borda count: top pick earns the most points.' },
  approval: { name: 'Approval vote', icon: '✅', blurb: 'Tick every book you’d be happy to read. Most approvals wins.' },
  random: { name: 'Random draw', icon: '🎲', blurb: 'Let fate decide. Books people have already read get a smaller chance.' },
};
const FORMAT_LABEL = { print: '📖 Print', kindle: '📱 Kindle', audible: '🎧 Audible', other: 'Other' };

// ------------------------------------------------------------ router

const routes = [
  [/^#\/login$/, renderLogin],
  [/^#\/?$/, renderHome],
  [/^#\/library$/, renderLibrary],
  [/^#\/members$/, renderMembers],
  [/^#\/meetings\/(\d+)$/, renderMeeting],
  [/^#\/books\/(\d+)$/, renderBook],
];

async function route() {
  const hash = location.hash || '#/';
  document.getElementById('topbar').hidden = !me;
  $$('.topbar nav a', document).forEach((a) => a.classList.toggle('active', a.getAttribute('href') === hash));
  if (!me && hash !== '#/login') {
    location.hash = '#/login';
    return;
  }
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (err) {
        if (me) app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p><a href="#/">Go home</a></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = `<div class="empty"><h2>Page not found</h2><a href="#/">Go home</a></div>`;
}

/** Re-render the current page without jumping to the top. */
async function refresh() {
  const y = window.scrollY;
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      await fn(...m.slice(1));
      window.scrollTo(0, y);
      return;
    }
  }
}

// ------------------------------------------------------------ login

function renderLogin() {
  if (me) {
    location.hash = '#/';
    return;
  }
  app.innerHTML = `
    <div class="login card">
      <h1>📚 ${esc(config.clubName)}</h1>
      <p class="muted">New here? Pick a name and a PIN to create your account. Returning? Use the same name and PIN.</p>
      <form id="join" class="stack">
        <div><label for="name">Your name</label><input id="name" autocomplete="username" required maxlength="40" /></div>
        <div><label for="pin">PIN (4+ characters)</label><input id="pin" type="password" autocomplete="current-password" required minlength="4" /></div>
        ${
          config.passcodeRequired
            ? `<div><label for="passcode">Club passcode <span class="muted small">(first time only)</span></label><input id="passcode" autocomplete="off" /></div>`
            : ''
        }
        <button class="primary" type="submit">Enter the club</button>
      </form>
    </div>`;
  $('#join').addEventListener(
    'submit',
    action(async () => {
      const data = await api('/join', {
        method: 'POST',
        body: { name: $('#name').value, pin: $('#pin').value, passcode: $('#passcode')?.value },
      });
      setMe(data.member);
      location.hash = '#/';
    }),
  );
}

function setMe(member) {
  me = member;
  document.getElementById('me-name').textContent = member ? `Hi, ${member.name}` : '';
}

// ------------------------------------------------------------ home

async function renderHome() {
  const { meetings } = await api('/meetings');
  const today = new Date().toISOString().slice(0, 10);
  const decided = meetings.filter((m) => m.status === 'decided' && m.chosen_book_id);
  // "Now reading": the next decided meeting that hasn't happened yet, else the most recent one.
  const upcomingDecided = decided.filter((m) => !m.meeting_date || m.meeting_date >= today);
  const current = upcomingDecided.sort((a, b) => (a.meeting_date || '9999').localeCompare(b.meeting_date || '9999'))[0] ?? decided[0];
  const open = meetings.filter((m) => m.status !== 'decided');
  const upcoming = upcomingDecided.filter((m) => m !== current);
  const past = decided.filter((m) => m !== current && !upcoming.includes(m));

  let currentHtml = '';
  if (current) {
    const { book, progress } = await api(`/books/${current.chosen_book_id}`);
    const mine = progress.find((p) => p.member_id === me.id);
    currentHtml = `
      <section class="card">
        <div class="row spread"><span class="pill accent">Now reading · ${esc(current.title)} · ${esc(fmtDate(current.meeting_date))}</span>
          <a href="#/meetings/${current.id}" class="small">Meeting details →</a></div>
        <div class="book-row now-reading" style="margin-top:14px">
          <a href="#/books/${book.id}">${cover(book, 'md')}</a>
          <div style="flex:1;min-width:0">
            <h2 style="margin-top:0"><a href="#/books/${book.id}" style="color:inherit">${esc(book.title)}</a></h2>
            <p class="muted" style="margin-top:-6px">${esc(book.authors)}</p>
            ${progressList(progress)}
            ${progressForm(mine)}
          </div>
        </div>
      </section>`;
  }

  app.innerHTML = `
    <div class="row spread"><h1>${esc(config.clubName)}</h1><button class="primary" id="new-meeting">+ New meeting</button></div>
    <form id="meeting-form" class="card stack" hidden>
      <h3>Plan a meeting</h3>
      <div><label for="m-title">Name</label><input id="m-title" required placeholder="e.g. November meetup" /></div>
      <div class="row">
        <div style="flex:1;min-width:160px"><label for="m-date">Date</label><input id="m-date" type="date" /></div>
        <div style="flex:2;min-width:200px"><label for="m-loc">Where</label><input id="m-loc" placeholder="Sam's place / Zoom link" /></div>
      </div>
      <div class="row"><button class="primary" type="submit">Create</button><button type="button" id="cancel-meeting">Cancel</button></div>
    </form>
    ${currentHtml}
    <h2>Picking the next book</h2>
    ${open.length ? `<div class="grid">${open.map(meetingCard).join('')}</div>` : `<div class="card flat empty">No meetings are collecting suggestions. Start one with “New meeting”.</div>`}
    ${upcoming.length ? `<h2>Coming up</h2><div class="grid">${upcoming.map(meetingCard).join('')}</div>` : ''}
    ${past.length ? `<h2>Past meetings</h2><div class="grid">${past.map(meetingCard).join('')}</div>` : ''}
  `;

  on('#new-meeting', 'click', () => {
    $('#meeting-form').hidden = false;
    $('#m-title').focus();
  });
  on('#cancel-meeting', 'click', () => ($('#meeting-form').hidden = true));
  $('#meeting-form').addEventListener(
    'submit',
    action(async () => {
      const { id } = await api('/meetings', {
        method: 'POST',
        body: { title: $('#m-title').value, meeting_date: $('#m-date').value, location: $('#m-loc').value },
      });
      location.hash = `#/meetings/${id}`;
    }),
  );
  if (current) bindProgressForm(current.chosen_book_id);
}

function meetingCard(m) {
  const status = { suggesting: 'Taking suggestions', voting: 'Voting open', decided: 'Book chosen' }[m.status];
  return `
    <a class="card book-card" href="#/meetings/${m.id}" style="color:inherit;text-decoration:none">
      <div class="row spread"><span class="pill ${m.status === 'decided' ? 'good' : 'accent'}">${status}</span><span class="small muted">${esc(fmtDate(m.meeting_date))}</span></div>
      <div class="title">${esc(m.title)}</div>
      ${
        m.chosen_book_id
          ? `<div class="book-row">${cover({ cover_url: m.book_cover, title: m.book_title }, 'sm')}<div><strong>${esc(m.book_title)}</strong><div class="small muted">${esc(m.book_authors)}</div></div></div>`
          : `<div class="muted small">${m.suggestion_count} book${m.suggestion_count === 1 ? '' : 's'} suggested</div>`
      }
    </a>`;
}

function progressList(progress) {
  if (!progress.length) return `<p class="muted small">Nobody has logged progress yet.</p>`;
  return `<div class="stack" style="margin:12px 0">${progress
    .map(
      (p) => `
      <div>
        <div class="row spread small"><strong>${esc(p.name)}</strong><span class="muted">${FORMAT_LABEL[p.format] ?? ''} · ${p.percent}% · ${ago(p.updated_at)}</span></div>
        <div class="progress" role="progressbar" aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${p.percent}%"></span></div>
        ${p.note ? `<div class="small muted">“${esc(p.note)}”</div>` : ''}
      </div>`,
    )
    .join('')}</div>`;
}

function progressForm(mine) {
  const pct = mine?.percent ?? 0;
  const fmt = mine?.format ?? 'print';
  return `
    <form id="progress-form" class="card flat stack" style="background:var(--surface-2)">
      <div class="row spread"><strong>Your progress</strong><span id="pct-label">${pct}%</span></div>
      <input type="range" id="pct" min="0" max="100" step="1" value="${pct}" aria-label="Percent complete" />
      <div class="row">
        <select id="fmt" style="width:auto">${Object.entries(FORMAT_LABEL)
          .map(([k, v]) => `<option value="${k}" ${k === fmt ? 'selected' : ''}>${v}</option>`)
          .join('')}</select>
        <input id="pnote" placeholder="Optional note (no spoilers!)" maxlength="280" value="${esc(mine?.note ?? '')}" style="flex:1;min-width:160px" />
        <button class="primary small" type="submit">Update</button>
      </div>
      <p class="small muted" style="margin:0">Tip: copy the % from your Kindle’s progress bar or Audible’s “time left”.</p>
    </form>`;
}

function bindProgressForm(bookId) {
  const form = $('#progress-form');
  if (!form) return;
  $('#pct').addEventListener('input', (e) => ($('#pct-label').textContent = `${e.target.value}%`));
  form.addEventListener(
    'submit',
    action(async () => {
      await api(`/books/${bookId}/progress`, {
        method: 'PUT',
        body: { percent: Number($('#pct').value), format: $('#fmt').value, note: $('#pnote').value },
      });
      toast('Progress updated');
      await refresh();
    }),
  );
}

// ------------------------------------------------------------ book search widget

/**
 * Renders a search box that looks books up via Google Books / Open Library.
 * onPick receives the saved book's id.
 */
function bookSearch(container, { onPick, cta = 'Add', extra = () => ({}) }) {
  container.innerHTML = `
    <form class="row search-form">
      <input type="search" placeholder="Search by title, author or ISBN…" style="flex:1;min-width:200px" required />
      <button type="submit">Search</button>
    </form>
    <div class="search-results"></div>
    <details class="small" style="margin-top:8px"><summary class="muted">Can’t find it? Add manually</summary>
      <form class="row manual-form" style="margin-top:8px">
        <input name="title" placeholder="Title" required style="flex:2;min-width:160px" />
        <input name="authors" placeholder="Author" style="flex:1;min-width:120px" />
        <button type="submit">${esc(cta)}</button>
      </form>
    </details>`;
  const results = $('.search-results', container);
  $('.search-form', container).addEventListener(
    'submit',
    action(async () => {
      const q = $('input', container).value.trim();
      if (!q) return;
      results.innerHTML = `<p class="muted small">Searching…</p>`;
      const { results: items } = await api(`/search?q=${encodeURIComponent(q)}`);
      if (!items.length) {
        results.innerHTML = `<p class="muted small">No matches. Try different words or add it manually.</p>`;
        return;
      }
      results.innerHTML = items
        .map(
          (b, i) => `
        <div class="book-row">
          ${cover(b, 'sm')}
          <div style="flex:1;min-width:0">
            <strong>${esc(b.title)}</strong>
            <div class="small muted">${esc(b.authors.join(', '))}${b.published ? ` · ${esc(b.published.slice(0, 4))}` : ''}${b.pageCount ? ` · ${b.pageCount} pages` : ''}</div>
            ${b.snippet ? `<div class="small clamp">${esc(b.snippet)}</div>` : ''}
          </div>
          <button class="small primary" data-i="${i}">${esc(cta)}</button>
        </div>`,
        )
        .join('');
      $$('button[data-i]', results).forEach((btn) =>
        btn.addEventListener(
          'click',
          action(async (e) => {
            btn.textContent = 'Fetching details…';
            const { id } = await api('/books', { method: 'POST', body: { sourceId: items[Number(e.currentTarget.dataset.i)].sourceId, ...extra() } });
            await onPick(id);
          }),
        ),
      );
    }),
  );
  $('.manual-form', container).addEventListener(
    'submit',
    action(async (e) => {
      const f = new FormData(e.target);
      const { id } = await api('/books', { method: 'POST', body: { title: f.get('title'), authors: f.get('authors'), ...extra() } });
      await onPick(id);
    }),
  );
}

// ------------------------------------------------------------ suggestions (shared)

/** Fills the <datalist> used by "Suggested by" inputs with member names. */
async function loadMemberNames() {
  const list = document.getElementById('member-names');
  if (list.dataset.loaded) return;
  const { members } = await api('/members');
  list.innerHTML = members.map((m) => `<option value="${esc(m.name)}"></option>`).join('');
  list.dataset.loaded = '1';
}

/** "Suggest a book" box: who suggested it, an optional pitch, then search or manual entry. */
function suggestBox(container, onDone) {
  container.innerHTML = `
    <div class="row">
      <div style="flex:1;min-width:160px"><label for="s-by">Suggested by</label>
        <input id="s-by" list="member-names" maxlength="60" value="${esc(me.name)}" /></div>
      <div style="flex:3;min-width:220px"><label for="s-pitch">Why this one? <span class="muted small">(optional)</span></label>
        <input id="s-pitch" maxlength="1000" placeholder="It’s short, it’s funny, and the ending will start arguments." /></div>
    </div>
    <div class="s-search" style="margin-top:12px"></div>`;
  loadMemberNames().catch(() => {});
  bookSearch($('.s-search', container), {
    cta: 'Suggest',
    extra: () => ({ suggestedBy: $('#s-by', container).value, pitch: $('#s-pitch', container).value }),
    onPick: async (id) => {
      toast('Book suggested!');
      await onDone(id);
    },
  });
}

function editBookForm(b) {
  const id = b.book_id ?? b.id;
  const removable = !b.club_pick;
  return `
    <form class="edit-book card flat stack small" data-book="${id}" hidden style="background:var(--surface-2)">
      <div><label>Suggested by</label><input name="suggested_by" list="member-names" maxlength="60" value="${esc(b.suggested_by ?? '')}" /></div>
      <div><label>Pitch</label><input name="pitch" maxlength="1000" value="${esc(b.pitch ?? '')}" placeholder="Why read this one?" /></div>
      <div><label>Title</label><input name="title" maxlength="300" required value="${esc(b.title)}" /></div>
      <div><label>Author</label><input name="authors" maxlength="300" value="${esc(b.authors ?? '')}" /></div>
      <div class="row">
        <button class="primary small" type="submit">Save</button>
        <button class="small" type="button" data-cancel-edit="${id}">Cancel</button>
        ${removable ? `<button class="link small" type="button" data-delete-book="${id}" style="margin-left:auto">Remove suggestion</button>` : ''}
      </div>
    </form>`;
}

/** A suggestion card with "Suggested by", pitch, the already-read toggle and inline editing. */
function bookCard(b, { editable = true } = {}) {
  const id = b.book_id ?? b.id;
  return `
    <div class="card book-card" data-text="${esc(`${b.title} ${b.authors} ${b.suggested_by ?? ''}`.toLowerCase())}">
      <a href="#/books/${id}">${cover(b)}</a>
      <div>
        <a class="title" href="#/books/${id}">${esc(b.title)}</a>
        <div class="small muted">${esc(b.authors)}${b.published ? ` · ${esc(String(b.published).slice(0, 4))}` : ''}${b.page_count ? ` · ${b.page_count}p` : ''}</div>
      </div>
      <div class="small">Suggested by: <strong>${esc(b.suggested_by || 'unknown')}</strong></div>
      ${b.pitch ? `<div class="small">“${esc(b.pitch)}”</div>` : ''}
      ${b.read_count ? `<div class="small"><span class="pill warn">Already read by ${esc(b.read_by)}</span></div>` : ''}
      ${
        editable
          ? `<label class="row small" style="font-weight:400;gap:6px;margin:0">
              <input type="checkbox" data-read="${id}" ${b.read_by_me ? 'checked' : ''} /> I’ve read this before
            </label>
            <button class="link small" data-edit="${id}" style="align-self:flex-start">✎ Edit</button>
            ${editBookForm(b)}`
          : ''
      }
    </div>`;
}

/** Wires up the read toggles and edit forms rendered by bookCard / editBookForm. */
function bindBookCards({ afterDelete = refresh } = {}) {
  on(
    '[data-read]',
    'change',
    action(async (e) => {
      await api(`/books/${e.target.dataset.read}/read`, { method: 'PUT', body: { read: e.target.checked } });
      await refresh();
    }),
  );
  const form = (id) => $(`form.edit-book[data-book="${id}"]`);
  on('[data-edit]', 'click', (e) => {
    loadMemberNames().catch(() => {});
    const f = form(e.currentTarget.dataset.edit);
    f.hidden = !f.hidden;
    if (!f.hidden) f.querySelector('input').focus();
  });
  on('[data-cancel-edit]', 'click', (e) => (form(e.currentTarget.dataset.cancelEdit).hidden = true));
  on(
    'form.edit-book',
    'submit',
    action(async (e) => {
      const f = new FormData(e.target);
      await api(`/books/${e.target.dataset.book}`, { method: 'PATCH', body: Object.fromEntries(f) });
      toast('Saved');
      await refresh();
    }),
  );
  on(
    '[data-delete-book]',
    'click',
    action(async (e) => {
      if (!confirm('Remove this book from the suggestions? Any votes for it will be dropped.')) return;
      await api(`/books/${e.currentTarget.dataset.deleteBook}`, { method: 'DELETE' });
      toast('Suggestion removed');
      await afterDelete();
    }),
  );
}

// ------------------------------------------------------------ meeting page

async function renderMeeting(id) {
  const data = await api(`/meetings/${id}`);
  const { meeting: m, suggestions, methodVotes, myMethod, effectiveMethod, myRanking, myApprovals, voters, standings } = data;
  const steps = ['suggesting', 'voting', 'decided'];
  const stepLabels = { suggesting: '1 · Suggest', voting: '2 · Vote', decided: '3 · Decided' };
  const decided = m.status === 'decided';
  const isHost = m.created_by === me.id;

  const chosen = decided ? suggestions.find((s) => s.book_id === m.chosen_book_id) : null;

  app.innerHTML = `
    <a href="#/" class="small">← All meetings</a>
    <div class="row spread" style="margin-top:8px">
      <div>
        <h1 style="margin-bottom:4px">${esc(m.title)}</h1>
        <div class="muted">${esc(fmtDate(m.meeting_date))}${m.location ? ` · ${esc(m.location)}` : ''}
          <button class="link small" id="edit-meeting">Edit</button></div>
      </div>
      ${isHost ? `<button class="small" id="delete-meeting">Delete meeting</button>` : ''}
    </div>
    <form id="edit-form" class="card stack" hidden style="margin-top:12px">
      <div><label>Name</label><input id="e-title" value="${esc(m.title)}" required /></div>
      <div class="row">
        <div style="flex:1;min-width:160px"><label>Date</label><input id="e-date" type="date" value="${esc(m.meeting_date ?? '')}" /></div>
        <div style="flex:2;min-width:200px"><label>Where</label><input id="e-loc" value="${esc(m.location ?? '')}" /></div>
      </div>
      <div class="row"><button class="primary" type="submit">Save</button></div>
    </form>
    <div class="stepper">${steps.map((s) => `<span class="${s === m.status ? 'on' : ''}">${stepLabels[s]}</span>`).join('')}</div>

    ${decided ? decidedHtml(m, chosen) : ''}

    <section>
      <div class="row spread"><h2>${decided ? 'What was on the ballot' : 'Suggestions'} (${suggestions.length})</h2>
        ${!decided ? `<button class="primary small" id="show-suggest">+ Suggest a book</button>` : ''}</div>
      ${!decided ? `<p class="small muted" style="margin-top:-6px">Every book on the <a href="#/library">Suggestions</a> page is in the running.</p>` : ''}
      <div id="suggest-box" class="card" hidden></div>
      ${
        suggestions.length
          ? `<div class="grid" style="margin-top:12px">${suggestions.map((s) => bookCard(s, { editable: !decided })).join('')}</div>`
          : `<div class="card flat empty">No suggestions yet — be the first!</div>`
      }
    </section>

    ${!decided && suggestions.length ? votingHtml(m, suggestions, methodVotes, myMethod, effectiveMethod, myRanking, myApprovals, voters, standings) : ''}
  `;

  // --- edit / delete
  on('#edit-meeting', 'click', () => ($('#edit-form').hidden = !$('#edit-form').hidden));
  $('#edit-form').addEventListener(
    'submit',
    action(async () => {
      await api(`/meetings/${id}`, {
        method: 'PATCH',
        body: { title: $('#e-title').value, meeting_date: $('#e-date').value, location: $('#e-loc').value },
      });
      toast('Saved');
      await refresh();
    }),
  );
  on(
    '#delete-meeting',
    'click',
    action(async () => {
      if (!confirm('Delete this meeting and all its suggestions and votes?')) return;
      await api(`/meetings/${id}`, { method: 'DELETE' });
      location.hash = '#/';
    }),
  );

  // --- suggestions
  on('#show-suggest', 'click', () => {
    const box = $('#suggest-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('.s-search input[type=search]').focus();
  });
  if ($('#suggest-box')) suggestBox($('#suggest-box'), () => refresh());
  bindBookCards();

  // --- stage + method
  on(
    '[data-status]',
    'click',
    action(async (e) => {
      const status = e.currentTarget.dataset.status;
      if (m.status === 'decided' && !confirm('Re-open voting? The current pick will be cleared.')) return;
      await api(`/meetings/${id}`, { method: 'PATCH', body: { status } });
      await refresh();
    }),
  );
  on(
    '[data-method]',
    'click',
    action(async (e) => {
      const method = e.currentTarget.dataset.method;
      await api(`/meetings/${id}/method`, { method: 'PUT', body: { method: method === myMethod ? null : method } });
      await refresh();
    }),
  );

  // --- ballots
  if ($('#rank-list')) bindRanking(id, suggestions, myRanking);
  on(
    '#save-approvals',
    'click',
    action(async () => {
      const bookIds = $$('[data-approve]:checked').map((el) => Number(el.dataset.approve));
      await api(`/meetings/${id}/approvals`, { method: 'PUT', body: { bookIds } });
      toast('Approval ballot saved');
      await refresh();
    }),
  );

  // --- decide
  on(
    '#decide',
    'click',
    action(async () => {
      const label = METHOD_INFO[effectiveMethod].name.toLowerCase();
      if (!confirm(`Pick the book now using ${label}? This closes voting.`)) return;
      if (effectiveMethod === 'random') await shuffleAnimation(suggestions);
      await api(`/meetings/${id}/decide`, { method: 'POST', body: { method: effectiveMethod } });
      await refresh();
      $('.winner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }),
  );
}

function votingHtml(m, suggestions, methodVotes, myMethod, effectiveMethod, myRanking, myApprovals, voters, standings) {
  const count = (method) => methodVotes.filter((v) => v.method === method);
  const methodCards = Object.entries(METHOD_INFO)
    .map(([key, info]) => {
      const vs = count(key);
      return `
      <button class="card method ${myMethod === key ? 'mine' : ''}" data-method="${key}" ${m.status === 'decided' ? 'disabled' : ''}>
        <strong>${info.icon} ${info.name}${effectiveMethod === key ? ' <span class="pill accent">in use</span>' : ''}</strong>
        <span class="small muted">${info.blurb}</span>
        <div class="small" style="margin-top:8px">${vs.length} vote${vs.length === 1 ? '' : 's'}${vs.length ? `: ${esc(vs.map((v) => v.name).join(', '))}` : ''}</div>
      </button>`;
    })
    .join('');

  let ballot = '';
  if (m.status === 'suggesting') {
    ballot = `<div class="card flat">
      <p style="margin-top:0">Still gathering suggestions. When everyone has added their picks, open voting.</p>
      <button class="primary" data-status="voting">Open voting →</button></div>`;
  } else if (effectiveMethod === 'ranked') {
    const ranked = myRanking.map((id) => suggestions.find((s) => s.book_id === id)).filter(Boolean);
    const rest = suggestions.filter((s) => !myRanking.includes(s.book_id));
    ballot = `
      <div class="card">
        <h3>Your ranking</h3>
        <p class="small muted" style="margin-top:0">Use the arrows to put your favourite at the top. Books below the line are left unranked (0 points).</p>
        <ol class="rank-list" id="rank-list">
          ${[...ranked, ...rest].map((s, i) => rankItem(s, i, i < ranked.length || !myRanking.length)).join('')}
        </ol>
        <div class="row"><button class="primary" id="save-ranking">Save my ranking</button>
          <span class="small muted">${myRanking.length ? 'Saved ✓ — you can change it until the pick.' : 'Not submitted yet.'}</span></div>
      </div>`;
  } else if (effectiveMethod === 'approval') {
    ballot = `
      <div class="card">
        <h3>Your approval ballot</h3>
        <p class="small muted" style="margin-top:0">Tick every book you’d be happy to read.</p>
        ${suggestions
          .map(
            (s) => `<label class="row" style="font-weight:400;margin-bottom:6px">
              <input type="checkbox" data-approve="${s.book_id}" ${myApprovals.includes(s.book_id) ? 'checked' : ''} />
              ${cover(s, 'sm')}<span><strong>${esc(s.title)}</strong><br /><span class="small muted">${esc(s.authors)}</span></span></label>`,
          )
          .join('')}
        <div class="row"><button class="primary" id="save-approvals">Save my ballot</button>
          <span class="small muted">${myApprovals.length ? 'Saved ✓' : 'Not submitted yet.'}</span></div>
      </div>`;
  } else {
    ballot = `<div class="card flat"><p style="margin:0">🎲 No ballot needed for a random draw. Each book’s chance shrinks by up to
      ${Math.round(config.readPenalty * 100)}% depending on how many members have already read it.</p></div>`;
  }

  const relevantVoters = voters.filter((v) => v.kind === effectiveMethod).map((v) => v.name);
  const standingsHtml =
    standings && m.status === 'voting'
      ? `<div class="card" style="margin-top:12px">
          <h3>Current standings</h3>
          <table>
            <thead><tr><th>Book</th><th>${effectiveMethod === 'ranked' ? 'Points' : 'Approvals'}</th><th>Read penalty</th><th>Score</th></tr></thead>
            <tbody>${standings
              .map(
                (s) => `<tr><td>${esc(s.title)}</td><td>${s.rawScore}</td>
                <td>${s.readFactor < 1 ? `×${s.readFactor}` : '—'}</td><td><strong>${s.score}</strong></td></tr>`,
              )
              .join('')}</tbody>
          </table>
          <p class="small muted">Ballots in: ${relevantVoters.length ? esc(relevantVoters.join(', ')) : 'none yet'}</p>
        </div>`
      : '';

  return `
    <section>
      <h2>How should we choose?</h2>
      <p class="muted small" style="margin-top:-6px">Vote for a method — the most popular one is used (ties go to ranked choice).</p>
      <div class="methods">${methodCards}</div>
    </section>
    <section>
      <h2>${m.status === 'suggesting' ? 'Voting' : 'Cast your vote'}</h2>
      ${ballot}
      ${standingsHtml}
      ${
        m.status === 'voting'
          ? `<div class="row" style="margin-top:16px">
              <button class="primary" id="decide">${METHOD_INFO[effectiveMethod].icon} Pick the book (${METHOD_INFO[effectiveMethod].name})</button>
              <button data-status="suggesting">← Back to suggestions</button>
            </div>`
          : ''
      }
    </section>`;
}

function rankItem(s, i, ranked) {
  return `
    <li data-id="${s.book_id}" class="${ranked ? '' : 'unranked'}">
      <span class="pos">${ranked ? i + 1 : '–'}</span>
      ${cover(s, 'sm')}
      <div class="grow"><strong>${esc(s.title)}</strong><div class="small muted">${esc(s.authors)}</div></div>
      <button class="small" data-move="-1" aria-label="Move up">↑</button>
      <button class="small" data-move="1" aria-label="Move down">↓</button>
      <button class="small" data-toggle aria-label="${ranked ? 'Leave unranked' : 'Rank this'}">${ranked ? '✕' : '+'}</button>
    </li>`;
}

function bindRanking(meetingId, suggestions, myRanking) {
  const list = $('#rank-list');
  // Local ballot state: ordered ranked ids + unranked ids.
  let ranked = myRanking.length ? [...myRanking] : suggestions.map((s) => s.book_id);
  const all = suggestions.map((s) => s.book_id);
  const draw = () => {
    const rest = all.filter((id) => !ranked.includes(id));
    list.innerHTML = [...ranked, ...rest]
      .map((id, i) => rankItem(suggestions.find((s) => s.book_id === id), i, i < ranked.length))
      .join('');
  };
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(btn.closest('li').dataset.id);
    if (btn.hasAttribute('data-toggle')) {
      ranked = ranked.includes(id) ? ranked.filter((x) => x !== id) : [...ranked, id];
    } else {
      const idx = ranked.indexOf(id);
      if (idx === -1) return;
      const to = idx + Number(btn.dataset.move);
      if (to < 0 || to >= ranked.length) return;
      [ranked[idx], ranked[to]] = [ranked[to], ranked[idx]];
    }
    draw();
  });
  $('#save-ranking').addEventListener(
    'click',
    action(async () => {
      await api(`/meetings/${meetingId}/ranking`, { method: 'PUT', body: { bookIds: ranked } });
      toast('Ranking saved');
      await refresh();
    }),
  );
}

async function shuffleAnimation(suggestions) {
  const overlay = document.createElement('div');
  overlay.className = 'card winner shuffle';
  overlay.style.cssText = 'position:fixed;inset:20% 50% auto auto;transform:translate(50%,0);z-index:50;width:260px';
  document.body.appendChild(overlay);
  for (let i = 0; i < 14; i++) {
    const s = suggestions[Math.floor(Math.random() * suggestions.length)];
    overlay.innerHTML = `<div class="muted small">Drawing…</div>${cover(s)}<strong>${esc(s.title)}</strong>`;
    await new Promise((r) => setTimeout(r, 90 + i * 12));
  }
  overlay.remove();
}

function decidedHtml(m, chosen) {
  const r = m.result;
  const method = METHOD_INFO[m.method] ?? METHOD_INFO.ranked;
  const breakdown = r
    ? `<details style="margin-top:12px;text-align:left"><summary class="small muted">How it was decided</summary>
        <table style="margin-top:8px">
          <thead><tr><th>Book</th>${
            m.method === 'random' ? '<th>Chance</th>' : `<th>${m.method === 'ranked' ? 'Points' : 'Approvals'}</th><th>Read penalty</th><th>Score</th>`
          }</tr></thead>
          <tbody>${r.scores
            .map(
              (s) => `<tr><td>${s.bookId === r.winnerBookId ? '🏆 ' : ''}${esc(s.title)}</td>${
                m.method === 'random'
                  ? `<td>${Math.round((s.chance ?? 0) * 100)}%</td>`
                  : `<td>${s.rawScore}</td><td>${s.readFactor < 1 ? `×${s.readFactor}` : '—'}</td><td>${s.score}</td>`
              }</tr>`,
            )
            .join('')}</tbody>
        </table>
        <p class="small muted">${r.ballots != null && m.method !== 'random' ? `${r.ballots} ballot${r.ballots === 1 ? '' : 's'} counted. ` : ''}${
          r.tiebreak ? 'There was a tie, broken at random. ' : ''
        }Picked by ${esc(r.decidedBy ?? 'a member')}.</p>
      </details>`
    : '';
  return `
    <section class="card winner reveal">
      <div class="pill accent">${method.icon} Chosen by ${method.name.toLowerCase()}</div>
      ${chosen ? `<a href="#/books/${chosen.book_id}">${cover(chosen)}</a><h2 style="margin:4px 0">${esc(chosen.title)}</h2><div class="muted">${esc(chosen.authors)}</div>` : '<p>The chosen book was removed.</p>'}
      <div class="row" style="justify-content:center;margin-top:14px">
        ${chosen ? `<a class="button primary" href="#/books/${chosen.book_id}">Book page, progress &amp; talking points →</a>` : ''}
        <button class="small" data-status="voting">Re-open voting</button>
      </div>
      ${breakdown}
    </section>`;
}

// ------------------------------------------------------------ book page

async function renderBook(id) {
  const { book, reviews, progress, readers, readByMe, talkingPoints, meetings } = await api(`/books/${id}`);
  const myReview = reviews.find((r) => r.member_id === me.id);
  const mine = progress.find((p) => p.member_id === me.id);
  const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

  app.innerHTML = `
    <a href="javascript:history.back()" class="small">← Back</a>
    <div class="two-col" style="margin-top:12px">
      <div class="stack">
        ${cover(book)}
        <a class="button" style="width:100%" href="${esc(book.audible_link)}" target="_blank" rel="noopener">🎧 Find on Audible</a>
        <a class="button" style="width:100%" href="${esc(book.kindle_link)}" target="_blank" rel="noopener">📱 Find on Kindle</a>
        <button class="link small" id="edit-links">Set exact store links</button>
        <form id="links-form" class="stack small" hidden>
          <input id="l-aud" placeholder="https://www.audible.com/pd/…" value="${esc(book.audible_url ?? '')}" />
          <input id="l-kin" placeholder="https://www.amazon.com/dp/…" value="${esc(book.kindle_url ?? '')}" />
          <button class="small" type="submit">Save links</button>
        </form>
      </div>
      <div>
        <h1 style="margin-bottom:4px">${esc(book.title)}</h1>
        <div class="muted">${esc(book.authors)}${book.published ? ` · ${esc(book.published)}` : ''}${book.page_count ? ` · ${book.page_count} pages` : ''}</div>
        <div class="row small" style="margin-top:6px">
          <span>Suggested by: <strong>${esc(book.suggested_by || 'unknown')}</strong></span>
          ${book.in_pool ? `<span class="pill accent">In the running for the next pick</span>` : ''}
          <button class="link small" data-edit="${book.id}">✎ Edit</button>
        </div>
        ${book.pitch ? `<p class="small" style="margin:6px 0 0">“${esc(book.pitch)}”</p>` : ''}
        ${editBookForm(book)}
        <div class="row" style="margin-top:8px">
          ${reviews.length ? `${stars(avg)} <span class="small muted">${avg.toFixed(1)} from ${reviews.length} review${reviews.length === 1 ? '' : 's'}</span>` : ''}
          ${book.categories ? book.categories.split(', ').slice(0, 3).map((c) => `<span class="pill">${esc(c)}</span>`).join('') : ''}
        </div>
        ${meetings.length ? `<p class="small">${meetings.map((mt) => `<a href="#/meetings/${mt.id}">${mt.chosen ? '🏆 Picked for' : 'Suggested for'} ${esc(mt.title)}</a>`).join(' · ')}</p>` : ''}
        ${book.description ? `<div class="prose" id="desc">${esc(book.description)}</div>` : `<p class="muted">No summary available.</p>`}

        <label class="row" style="font-weight:400;margin-top:16px">
          <input type="checkbox" id="read-before" ${readByMe ? 'checked' : ''} /> I read this before the club picked it
        </label>
        ${readers.length ? `<p class="small muted" style="margin:4px 0 0">Already read by: ${esc(readers.map((r) => r.name).join(', '))}</p>` : ''}

        ${
          book.author_bio
            ? `<h2>About ${esc(book.authors.split(',')[0])}</h2>
               <div class="book-row">${book.author_photo_url ? `<img src="${esc(book.author_photo_url)}" alt="" style="width:72px;border-radius:8px" />` : ''}
               <p class="prose" style="margin:0">${esc(book.author_bio)}</p></div>`
            : ''
        }

        <h2>Reading progress</h2>
        ${progressList(progress)}
        ${progressForm(mine)}

        <h2>Talking points</h2>
        <div id="tp">${talkingPointsHtml(talkingPoints)}</div>

        <h2>Reviews</h2>
        <form id="review-form" class="card stack">
          <strong>${myReview ? 'Your review' : 'Write a review'}</strong>
          <div class="star-input" id="star-input">${[1, 2, 3, 4, 5]
            .map((n) => `<button type="button" data-star="${n}" class="${n <= (myReview?.rating ?? 0) ? 'on' : ''}" aria-label="${n} stars">★</button>`)
            .join('')}</div>
          <textarea id="review-body" placeholder="What did you think?">${esc(myReview?.body ?? '')}</textarea>
          <div class="row"><button class="primary" type="submit">${myReview ? 'Update review' : 'Post review'}</button>
            ${myReview ? `<button type="button" id="delete-review" class="small">Delete</button>` : ''}</div>
        </form>
        <div class="stack" style="margin-top:12px">${
          reviews
            .map(
              (r) => `<div class="card flat"><div class="row spread"><strong>${esc(r.name)}</strong>
                <span>${stars(r.rating)} <span class="small muted">${ago(r.updated_at)}</span></span></div>
                ${r.body ? `<p class="prose" style="margin:8px 0 0">${esc(r.body)}</p>` : ''}</div>`,
            )
            .join('') || '<p class="muted">No reviews yet.</p>'
        }</div>
      </div>
    </div>`;

  on('#edit-links', 'click', () => ($('#links-form').hidden = !$('#links-form').hidden));
  $('#links-form').addEventListener(
    'submit',
    action(async () => {
      await api(`/books/${id}`, { method: 'PATCH', body: { audible_url: $('#l-aud').value, kindle_url: $('#l-kin').value } });
      toast('Links saved');
      await refresh();
    }),
  );
  $('#read-before').addEventListener(
    'change',
    action(async (e) => {
      await api(`/books/${id}/read`, { method: 'PUT', body: { read: e.target.checked } });
      await refresh();
    }),
  );
  bindProgressForm(id);
  bindBookCards({ afterDelete: () => (location.hash = '#/library') });

  let rating = myReview?.rating ?? 0;
  on('[data-star]', 'click', (e) => {
    rating = Number(e.currentTarget.dataset.star);
    $$('[data-star]').forEach((b) => b.classList.toggle('on', Number(b.dataset.star) <= rating));
  });
  $('#review-form').addEventListener(
    'submit',
    action(async () => {
      if (!rating) throw new Error('Pick a star rating first');
      await api(`/books/${id}/review`, { method: 'PUT', body: { rating, body: $('#review-body').value } });
      toast('Review saved');
      await refresh();
    }),
  );
  on(
    '#delete-review',
    'click',
    action(async () => {
      if (!confirm('Delete your review?')) return;
      await api(`/books/${id}/review`, { method: 'DELETE' });
      await refresh();
    }),
  );
  bindTalkingPoints(id);
}

function talkingPointsHtml(tp) {
  const llmNote = config.llm ? '' : '<p class="small muted">No AI model is configured on the server yet — see the README.</p>';
  if (!tp) {
    return `<div class="card flat">
      <p style="margin-top:0">Generate discussion questions tailored to this book (spoilers included — best used once everyone has finished).</p>
      <button class="primary" id="gen-tp" ${config.llm ? '' : 'disabled'}>✨ Generate talking points</button>${llmNote}</div>`;
  }
  const groups = {};
  for (const q of tp.questions) (groups[q.category] ??= []).push(q);
  return `
    <details class="card" open>
      <summary class="small muted">⚠️ Contains spoilers · generated ${ago(tp.created_at) || 'just now'} by ${esc(tp.model)}</summary>
      <p>${esc(tp.overview)}</p>
      <div class="row">${tp.themes.map((t) => `<span class="pill accent">${esc(t)}</span>`).join('')}</div>
      <h3 style="margin-top:16px">Icebreaker</h3>
      <p>${esc(tp.icebreaker)}</p>
      ${Object.entries(groups)
        .map(
          ([cat, qs]) => `<h3 style="margin-top:16px">${esc(cat)}</h3>
          <ol class="questions">${qs.map((q) => `<li><div>${esc(q.question)}</div><div class="small muted">${esc(q.why)}</div></li>`).join('')}</ol>`,
        )
        .join('')}
      <div class="row" style="margin-top:12px">
        <button class="small" id="gen-tp" ${config.llm ? '' : 'disabled'}>↻ Regenerate</button>
        <button class="small" id="copy-tp">Copy as text</button>
      </div>
    </details>`;
}

function bindTalkingPoints(bookId) {
  on(
    '#gen-tp',
    'click',
    action(async (e) => {
      e.currentTarget.textContent = 'Thinking… (this can take up to a minute)';
      const { talkingPoints } = await api(`/books/${bookId}/talking-points`, { method: 'POST' });
      $('#tp').innerHTML = talkingPointsHtml(talkingPoints);
      bindTalkingPoints(bookId);
    }),
  );
  on('#copy-tp', 'click', async () => {
    const text = $('#tp details').innerText.replace(/↻ Regenerate\s*Copy as text\s*$/, '').trim();
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  });
}

// ------------------------------------------------------------ library & members

async function renderLibrary() {
  const { books } = await api('/books');
  const pool = books.filter((b) => b.in_pool);
  const picks = books.filter((b) => !b.in_pool && b.club_pick);
  const others = books.filter((b) => !b.in_pool && !b.club_pick);
  const grid = (list, opts) => `<div class="grid">${list.map((b) => bookCard(b, opts)).join('')}</div>`;
  app.innerHTML = `
    <div class="row spread"><h1>Suggestions</h1><button class="primary" id="add-book">+ Suggest a book</button></div>
    <p class="muted" style="margin-top:-6px">Every book here is in the running when the next meeting votes. The winner moves to “Books we’ve read”.</p>
    <div id="add-box" class="card" hidden></div>
    ${books.length ? `<div class="row" style="margin:12px 0"><input id="filter" type="search" placeholder="Filter by title, author or who suggested it…" style="max-width:360px" /></div>` : ''}
    <div id="books">
      <h2>Up for the next pick (${pool.length})</h2>
      ${pool.length ? grid(pool) : `<div class="card flat empty">No suggestions yet. Add one with “Suggest a book”.</div>`}
      ${picks.length ? `<h2>Books we’ve read (${picks.length})</h2>${grid(picks, { editable: false })}` : ''}
      ${others.length ? `<h2>Other books</h2>${grid(others)}` : ''}
    </div>`;
  on('#add-book', 'click', () => {
    const box = $('#add-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('.s-search input[type=search]').focus();
  });
  suggestBox($('#add-box'), () => refresh());
  bindBookCards();
  on('#filter', 'input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#books [data-text]').forEach((el) => (el.style.display = el.dataset.text.includes(q) ? '' : 'none'));
  });
}

async function renderMembers() {
  const { members } = await api('/members');
  app.innerHTML = `
    <h1>Members</h1>
    <div class="card"><table>
      <thead><tr><th>Name</th><th>Suggestions</th><th>Reviews</th><th>Joined</th></tr></thead>
      <tbody>${members
        .map((m) => `<tr><td><strong>${esc(m.name)}</strong>${m.id === me.id ? ' <span class="pill">you</span>' : ''}</td>
          <td>${m.suggestion_count}</td><td>${m.review_count}</td><td class="muted small">${esc(m.created_at.slice(0, 10))}</td></tr>`)
        .join('')}</tbody>
    </table></div>
    <p class="muted small">Invite friends by sending them this site’s address${config.passcodeRequired ? ' and the club passcode' : ''}.</p>`;
}

// ------------------------------------------------------------ boot

document.getElementById('logout').addEventListener(
  'click',
  action(async () => {
    await api('/logout', { method: 'POST' });
    setMe(null);
    location.hash = '#/login';
  }),
);
window.addEventListener('hashchange', route);

(async () => {
  config = await fetch('/api/config')
    .then((r) => (checkVersion(r), r.json()))
    .catch(() => config);
  document.title = config.clubName;
  document.getElementById('club-name').textContent = config.clubName;
  try {
    const r = await fetch('/api/me');
    if (r.ok) setMe((await r.json()).member);
  } catch {}
  route();
})();
