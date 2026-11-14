DELETE FROM plays WHERE source_id IN
  (SELECT id FROM sources WHERE kind = 'listenbrainz');
DELETE FROM tokens WHERE source_id IN
  (SELECT id FROM sources WHERE kind = 'listenbrainz');
DELETE FROM sources WHERE kind = 'listenbrainz';

DELETE FROM track_totals;
INSERT INTO track_totals (user_id, track_id, plays, last_played_at)
  SELECT user_id, track_id, COUNT(*), MAX(played_at)
  FROM plays WHERE dup = 0 GROUP BY user_id, track_id;

DELETE FROM daily_totals;
INSERT INTO daily_totals (user_id, day, plays)
  SELECT user_id, played_at / 86400, COUNT(*)
  FROM plays WHERE dup = 0 GROUP BY user_id, played_at / 86400;

DELETE FROM artist_totals;
INSERT INTO artist_totals (user_id, artist_id, plays)
  SELECT plays.user_id, tracks.artist_id, COUNT(*)
  FROM plays JOIN tracks ON tracks.id = plays.track_id
  WHERE plays.dup = 0 GROUP BY plays.user_id, tracks.artist_id;
