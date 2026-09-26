-- The library doubles as the suggestion pool: every book with in_pool = 1 is a
-- candidate whenever a meeting votes. The winner leaves the pool.
ALTER TABLE books ADD COLUMN suggested_by TEXT;
ALTER TABLE books ADD COLUMN pitch TEXT;
ALTER TABLE books ADD COLUMN in_pool INTEGER NOT NULL DEFAULT 1;

UPDATE books SET suggested_by = (SELECT name FROM members WHERE members.id = books.added_by);
UPDATE books SET pitch = (SELECT s.pitch FROM suggestions s WHERE s.book_id = books.id AND s.pitch IS NOT NULL LIMIT 1);
UPDATE books SET in_pool = 0 WHERE id IN (SELECT chosen_book_id FROM meetings WHERE chosen_book_id IS NOT NULL);
