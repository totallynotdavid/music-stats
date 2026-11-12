CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  hash BLOB PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL CHECK (kind IN ('lastfm', 'listenbrainz', 'spotify', 'ytmusic')),
  account TEXT,
  secret BLOB,
  cursor INTEGER,
  backfill_before INTEGER,
  next_pull_at INTEGER,
  idle_pulls INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gap', 'error')),
  error TEXT,
  last_ok_at INTEGER,
  last_page TEXT,
  play_seq INTEGER NOT NULL DEFAULT 0,
  gap_at INTEGER,
  maybe_missing INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, kind)
);
CREATE INDEX sources_due ON sources (next_pull_at) WHERE next_pull_at IS NOT NULL;

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  hash BLOB NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX tokens_source ON tokens (source_id);

CREATE TABLE artists (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mbid TEXT
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  title TEXT NOT NULL,
  mbid TEXT,
  isrc TEXT
);
CREATE INDEX tracks_mbid ON tracks (mbid) WHERE mbid IS NOT NULL;
CREATE INDEX tracks_isrc ON tracks (isrc) WHERE isrc IS NOT NULL;

CREATE TABLE track_aliases (
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  PRIMARY KEY (kind, source_key)
) WITHOUT ROWID;

CREATE TABLE plays (
  user_id INTEGER NOT NULL REFERENCES users (id),
  played_at INTEGER NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  ref TEXT NOT NULL DEFAULT '',
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  dup INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, played_at, source_id, ref)
) WITHOUT ROWID;

CREATE TABLE track_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  plays INTEGER NOT NULL,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
) WITHOUT ROWID;
CREATE INDEX track_totals_top ON track_totals (user_id, plays DESC);

CREATE TRIGGER plays_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO track_totals (user_id, track_id, plays, last_played_at)
  VALUES (NEW.user_id, NEW.track_id, 1, NEW.played_at)
  ON CONFLICT (user_id, track_id) DO UPDATE SET
    plays = plays + 1,
    last_played_at = max(last_played_at, NEW.played_at);
END;

CREATE TRIGGER plays_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE track_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id AND track_id = NEW.track_id;
  DELETE FROM track_totals
  WHERE user_id = NEW.user_id AND track_id = NEW.track_id AND plays = 0;
END;
