CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  since INTEGER,
  last_check INTEGER,
  last_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
