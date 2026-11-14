CREATE TABLE categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  feed TEXT NOT NULL
    CHECK (feed IN ('deezer_chart', 'deezer_playlist', 'apple_chart', 'mine')),
  ref TEXT
);

INSERT INTO categories (slug, name, feed, ref) VALUES
  ('pop', 'Pop', 'deezer_chart', '132'),
  ('rock', 'Rock', 'deezer_chart', '152'),
  ('metal', 'Metal', 'deezer_chart', '464'),
  ('k-pop', 'K-pop', 'deezer_playlist', '4096400722'),
  ('anime', 'Anime', 'deezer_playlist', '5206929684'),
  ('top-50-japan', 'Top 50 Japan', 'apple_chart', 'jp'),
  ('top-50-peru', 'Top 50 Peru', 'apple_chart', 'pe'),
  ('top-50-global', 'Top 50 Global', 'deezer_chart', '0'),
  ('mine', 'From my listening', 'mine', NULL);
