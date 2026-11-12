PRAGMA defer_foreign_keys = on;

CREATE TABLE sources_copy AS SELECT * FROM sources;

DROP TABLE sources;

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL
    CHECK (kind IN ('lastfm', 'listenbrainz', 'spotify', 'ytmusic',
                    'spotify_import', 'ytmusic_import')),
  account TEXT,
  secret BLOB,
  cursor INTEGER,
  backfill_before INTEGER,
  next_pull_at INTEGER,
  idle_pulls INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'gap', 'error')),
  error TEXT,
  last_ok_at INTEGER,
  last_page TEXT,
  play_seq INTEGER NOT NULL DEFAULT 0,
  gap_at INTEGER,
  maybe_missing INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  gap_before INTEGER,
  gap_floor INTEGER,
  UNIQUE (user_id, kind)
);

INSERT INTO sources SELECT * FROM sources_copy;

DROP TABLE sources_copy;

CREATE INDEX sources_due ON sources (next_pull_at)
  WHERE next_pull_at IS NOT NULL;
CREATE INDEX plays_source ON plays (source_id);

CREATE TRIGGER plays_recounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 1 AND NEW.dup = 0
BEGIN
  INSERT INTO track_totals (user_id, track_id, plays, last_played_at)
  VALUES (NEW.user_id, NEW.track_id, 1, NEW.played_at)
  ON CONFLICT (user_id, track_id) DO UPDATE SET
    plays = plays + 1,
    last_played_at = max(last_played_at, NEW.played_at);
  INSERT INTO daily_totals (user_id, day, plays)
  VALUES (NEW.user_id, NEW.played_at / 86400, 1)
  ON CONFLICT (user_id, day) DO UPDATE SET plays = plays + 1;
  INSERT INTO artist_totals (user_id, artist_id, plays)
  SELECT NEW.user_id, tracks.artist_id, 1
  FROM tracks WHERE tracks.id = NEW.track_id
  ON CONFLICT (user_id, artist_id) DO UPDATE SET plays = plays + 1;
END;
