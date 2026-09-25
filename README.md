# Book-club

A web app for running a book club: suggest books for upcoming meetings, choose one by ranked vote,
approval vote or random draw, track everyone's reading progress, post reviews, and generate
discussion questions with an LLM.

It runs entirely on Cloudflare: a Worker serves the API and the static frontend, and a D1
(SQLite) database stores everything. There's no build step for the frontend.

## Features

- **Meetings**: each meeting goes *Suggest → Vote → Decided*. Anyone can create one.
- **Suggestions with real metadata**: search by title, author or ISBN. Cover, summary, page count,
  genres and an author bio are pulled from Google Books, Open Library and Wikipedia. Books you
  can't find can be added by hand.
- **Three ways to choose, picked by the group**. Members vote on which method to use, and the most
  popular one wins (ties go to ranked choice):
  - 🏆 **Ranked choice** (Borda count): order the books; 1st place gets the most points.
  - ✅ **Approval vote**: tick every book you'd be happy to read.
  - 🎲 **Random draw**: a weighted lottery.
  
  Live standings are shown while voting is open, and the full breakdown is kept after the pick.
- **"I've read this before"**: each member who has already read a book lowers its score (or its
  odds in a random draw). With the default `READ_PENALTY=0.5`, a book everyone has read keeps half
  its score. Set it to `0` to turn this off, or `1` to rule those books out completely.
- **Audible and Kindle links** on every book. By default they open a store search. You can paste an
  exact product link instead.
- **Reading progress**: everyone's % complete and format (print, Kindle or Audible), visible to the
  whole club on the home page and the book page.
- **Reviews**: 1–5 stars and an optional write-up.
- **AI talking points**: an overview, themes, an icebreaker and 10–12 discussion questions grouped
  by topic, written for the specific book. Existing member reviews are used to tailor them. Uses
  Claude when an Anthropic API key is set, and otherwise falls back to Cloudflare Workers AI
  (Llama 3.3).

### About linking Audible / Kindle accounts

Amazon doesn't offer a public API for Kindle or Audible reading progress, and scraping it would mean
storing members' Amazon passwords, so the app doesn't connect to those accounts. Instead, members
log their own % (the Kindle progress bar and Audible's "time left" make this quick). If Amazon ever
opens an API, `PUT /api/books/:id/progress` is the hook to feed it into.

## Deploying to Cloudflare

Prerequisites: Node 20+ and a Cloudflare account.

```bash
npm install
npx wrangler login

# 1. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create book-club

# 2. Create the tables
npm run db:migrate

# 3. Secrets
npx wrangler secret put CLUB_PASSCODE        # shared passcode new members need to join
npx wrangler secret put ANTHROPIC_API_KEY    # optional: Claude for talking points
npx wrangler secret put GOOGLE_BOOKS_API_KEY # optional but recommended, see below

# 4. Ship it
npm run deploy
```

Wrangler prints your URL (`https://book-club.<your-subdomain>.workers.dev`). To use your own
domain, add a custom domain to the Worker in the Cloudflare dashboard.

**Google Books key**: unauthenticated requests share a small global quota and often get
rate-limited. When that happens, search falls back to Open Library, which works but has fewer
covers and summaries. A free key from the Google Cloud console (enable the *Books API*) avoids this.

### Automatic deploys from GitHub

`.github/workflows/ci.yml` typechecks and tests every push. On `main`, it also applies migrations
and deploys, as long as these repository secrets are set:

- `CLOUDFLARE_API_TOKEN`: a token with the *Edit Cloudflare Workers* and *D1 Edit* permissions
- `CLOUDFLARE_ACCOUNT_ID`

Run steps 1–3 above once by hand first. Secrets set with `wrangler secret put` persist across
deploys.

## Configuration

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `CLUB_NAME` | var | `Book Club` | Shown in the header and login page |
| `READ_PENALTY` | var | `0.5` | 0–1, how much "already read" counts against a book |
| `CLAUDE_MODEL` | var | `claude-opus-5` | Claude model for talking points |
| `CLUB_PASSCODE` | secret | none | Required to create a new member. If unset, anyone with the URL can join |
| `ANTHROPIC_API_KEY` | secret | none | Enables Claude. Without it, Workers AI is used |
| `GOOGLE_BOOKS_API_KEY` | secret | none | Higher Google Books quota |

Claude requests use structured output, so the response always matches the talking-points schema.
They also enable the API's server-side refusal fallback (`fallbacks: "default"`), so a declined
request is retried on another model automatically.

## Accounts

Members sign in with a name and a PIN. Joining for the first time also needs the club passcode.
PINs are hashed with PBKDF2, and sessions are HttpOnly cookies. This is intended for a
friends-and-family club, not as high-security auth. Put the site behind Cloudflare Access if you
want real SSO.

## Local development

```bash
cp .dev.vars.example .dev.vars   # set CLUB_PASSCODE, optionally ANTHROPIC_API_KEY
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm test                         # unit tests (selection logic, metadata parsing, LLM calls with mocks)
npm run typecheck
```

The Workers AI binding always talks to Cloudflare, even in local dev, so `npm run dev` needs
`wrangler login`.

## Project layout

```
src/index.ts           API routes (Hono)
src/selection.ts       Borda / approval / weighted-random selection and the read penalty
src/metadata.ts        Google Books, Open Library and Wikipedia lookups; store links
src/talking-points.ts  Claude (structured output) and Workers AI generation
src/auth.ts            PIN hashing and session middleware
migrations/            D1 schema
public/                Frontend (index.html, app.js, styles.css)
test/                  Vitest unit tests
```
