-- Each member's Libby / OverDrive library, used for "Find on Libby" links and wait times
ALTER TABLE members ADD COLUMN libby_key TEXT;
ALTER TABLE members ADD COLUMN libby_name TEXT;
