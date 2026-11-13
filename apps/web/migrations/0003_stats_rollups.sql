CREATE TABLE daily_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  day INTEGER NOT NULL,
  plays INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;

CREATE TABLE artist_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  plays INTEGER NOT NULL,
  PRIMARY KEY (user_id, artist_id)
) WITHOUT ROWID;
CREATE INDEX artist_totals_top ON artist_totals (user_id, plays DESC);

INSERT INTO daily_totals (user_id, day, plays)
  SELECT user_id, played_at / 86400, COUNT(*)
  FROM plays WHERE dup = 0
  GROUP BY user_id, played_at / 86400;

INSERT INTO artist_totals (user_id, artist_id, plays)
  SELECT plays.user_id, tracks.artist_id, COUNT(*)
  FROM plays JOIN tracks ON tracks.id = plays.track_id
  WHERE plays.dup = 0
  GROUP BY plays.user_id, tracks.artist_id;

CREATE TRIGGER plays_day_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO daily_totals (user_id, day, plays)
  VALUES (NEW.user_id, NEW.played_at / 86400, 1)
  ON CONFLICT (user_id, day) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_day_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE daily_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id AND day = NEW.played_at / 86400;
  DELETE FROM daily_totals
  WHERE user_id = NEW.user_id AND day = NEW.played_at / 86400 AND plays = 0;
END;

CREATE TRIGGER plays_artist_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO artist_totals (user_id, artist_id, plays)
  SELECT NEW.user_id, tracks.artist_id, 1
  FROM tracks WHERE tracks.id = NEW.track_id
  ON CONFLICT (user_id, artist_id) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_artist_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE artist_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id
    AND artist_id = (SELECT artist_id FROM tracks WHERE id = NEW.track_id);
  DELETE FROM artist_totals
  WHERE user_id = NEW.user_id
    AND artist_id = (SELECT artist_id FROM tracks WHERE id = NEW.track_id)
    AND plays = 0;
END;
