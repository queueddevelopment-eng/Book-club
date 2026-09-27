-- Members and login sessions
CREATE TABLE members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every book the club has ever looked at, with metadata pulled at add time
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '',
  description TEXT,
  cover_url TEXT,
  published TEXT,
  page_count INTEGER,
  isbn TEXT,
  categories TEXT,
  author_bio TEXT,
  author_photo_url TEXT,
  source_id TEXT UNIQUE,          -- e.g. "google:abc123" or "ol:/works/OL1W"
  audible_url TEXT,
  kindle_url TEXT,
  added_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A meeting moves suggesting -> voting -> decided
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  meeting_date TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'suggesting' CHECK (status IN ('suggesting', 'voting', 'decided')),
  method TEXT CHECK (method IN ('ranked', 'approval', 'random')),
  chosen_book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
  result_json TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE suggestions (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  pitch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (meeting_id, book_id)
);

-- Which selection method each member would like to use for a meeting
CREATE TABLE method_votes (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('ranked', 'approval', 'random')),
  PRIMARY KEY (meeting_id, member_id)
);

-- Ranked ballots: position 1 is the member's favourite
CREATE TABLE rankings (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, member_id, book_id)
);

-- Approval ballots: one row per book a member would be happy to read
CREATE TABLE approvals (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, member_id, book_id)
);

-- "I've already read this" flags, which lower a book's chances
CREATE TABLE read_before (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, member_id)
);

CREATE TABLE reviews (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, member_id)
);

CREATE TABLE progress (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  percent INTEGER NOT NULL CHECK (percent BETWEEN 0 AND 100),
  format TEXT NOT NULL DEFAULT 'print' CHECK (format IN ('print', 'kindle', 'audible', 'other')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (book_id, member_id)
);

CREATE TABLE talking_points (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
