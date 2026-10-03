-- Members' personal shelves: posts about any book they're reading or have read,
-- separate from the club's suggestion pool.
CREATE TABLE shelf_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  published TEXT,
  source_id TEXT,                 -- same "google:" / "ol:" ids as books, so it can be suggested to the club
  status TEXT NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'finished', 'abandoned')),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX shelf_posts_member ON shelf_posts (member_id, updated_at);
CREATE INDEX shelf_posts_updated ON shelf_posts (updated_at);

CREATE TABLE shelf_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES shelf_posts(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX shelf_comments_post ON shelf_comments (post_id, created_at);
