import type { D1Database } from "@cloudflare/workers-types";
import type { Period, PeriodStats } from "./types";

interface TrackCount {
  title: string;
  artist: string;
  plays: number;
}

interface ArtistCount {
  artist: string;
  plays: number;
}

interface DailyCount {
  day: number;
  plays: number;
}

function periodStart(period: Period, now: number) {
  if (period === "week") return now - 7 * 86400;
  if (period === "month") return now - 30 * 86400;
  return null;
}

function dayText(dayNumber: number) {
  return new Date(dayNumber * 86400_000).toISOString().slice(0, 10);
}

export async function getStats(
  db: D1Database,
  userId: number,
  name: string,
  period: Period,
  now: number,
) {
  const from = periodStart(period, now);
  const range = from === null ? "" : " AND plays.played_at >= ?2";
  const rangeBind = from === null ? [userId] : [userId, from];
  const trackSql =
    period === "all"
      ? `SELECT tracks.title, artists.name AS artist, track_totals.plays
         FROM track_totals JOIN tracks ON tracks.id = track_totals.track_id
         JOIN artists ON artists.id = tracks.artist_id
         WHERE track_totals.user_id = ?1
         ORDER BY track_totals.plays DESC, track_totals.track_id LIMIT 10`
      : `SELECT tracks.title, artists.name AS artist, COUNT(*) AS plays
         FROM plays JOIN tracks ON tracks.id = plays.track_id
         JOIN artists ON artists.id = tracks.artist_id
         WHERE plays.user_id = ?1 AND plays.dup = 0${range}
         GROUP BY plays.track_id ORDER BY plays DESC, tracks.id LIMIT 10`;
  const artistSql =
    period === "all"
      ? `SELECT artists.name AS artist, artist_totals.plays
         FROM artist_totals JOIN artists ON artists.id = artist_totals.artist_id
         WHERE artist_totals.user_id = ?1
         ORDER BY artist_totals.plays DESC, artist_totals.artist_id LIMIT 10`
      : `SELECT artists.name AS artist, COUNT(*) AS plays
         FROM plays JOIN tracks ON tracks.id = plays.track_id
         JOIN artists ON artists.id = tracks.artist_id
         WHERE plays.user_id = ?1 AND plays.dup = 0${range}
         GROUP BY artists.id ORDER BY plays DESC, artists.id LIMIT 10`;
  const totalsSql =
    period === "all"
      ? `SELECT
         (SELECT SUM(plays) FROM track_totals WHERE user_id = ?1) AS plays,
         (SELECT COUNT(*) FROM track_totals WHERE user_id = ?1) AS unique_tracks,
         (SELECT COUNT(*) FROM artist_totals WHERE user_id = ?1) AS unique_artists`
      : `SELECT COUNT(*) AS plays, COUNT(DISTINCT plays.track_id) AS unique_tracks,
         COUNT(DISTINCT tracks.artist_id) AS unique_artists
         FROM plays JOIN tracks ON tracks.id = plays.track_id
         WHERE plays.user_id = ?1 AND plays.dup = 0${range}`;
  const dailySql =
    period === "all"
      ? `SELECT day, plays FROM daily_totals
         WHERE user_id = ?1 ORDER BY day`
      : `SELECT played_at / 86400 AS day, COUNT(*) AS plays
         FROM plays WHERE user_id = ?1 AND dup = 0${range}
         GROUP BY day ORDER BY day`;

  const [trackRows, artistRows, totals, daily] = await db.batch([
    db.prepare(trackSql).bind(...rangeBind),
    db.prepare(artistSql).bind(...rangeBind),
    db.prepare(totalsSql).bind(...rangeBind),
    db.prepare(dailySql).bind(...rangeBind),
  ]);
  const total = totals.results[0] as {
    plays: number | null;
    unique_tracks: number;
    unique_artists: number;
  } | null;
  return {
    schema: 1,
    user: { name },
    period,
    from,
    to: now,
    plays: total?.plays ?? 0,
    unique_tracks: total?.unique_tracks ?? 0,
    unique_artists: total?.unique_artists ?? 0,
    top_tracks: trackRows.results as unknown as TrackCount[],
    top_artists: artistRows.results as unknown as ArtistCount[],
    daily: (daily.results as unknown as DailyCount[]).map((row) => ({
      day: dayText(row.day),
      plays: row.plays,
    })),
    updated_at: now,
  } satisfies PeriodStats;
}
