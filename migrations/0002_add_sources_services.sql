PRAGMA foreign_keys=OFF;
CREATE TABLE content_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'system-video', 'content-video', 'source', 'service')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_public_id TEXT NOT NULL DEFAULT '',
  content_url TEXT NOT NULL DEFAULT '',
  technologies TEXT NOT NULL DEFAULT '[]',
  topic TEXT NOT NULL DEFAULT '',
  views TEXT NOT NULL DEFAULT '0',
  duration TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  video_public_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO content_v2 SELECT * FROM content;
DROP TABLE content;
ALTER TABLE content_v2 RENAME TO content;
CREATE INDEX IF NOT EXISTS idx_content_kind_created ON content (kind, created_at DESC);
PRAGMA foreign_keys=ON;
