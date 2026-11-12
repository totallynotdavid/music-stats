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
  day: string;
  plays: number;
}

function periodStart(period: Period, now: number) {
  if (period === "week") return now - 7 * 86400;
  if (period === "month") return now - 30 * 86400;
  return null;
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
  const trackRows =
    period === "all"
      ? await db
          .prepare(
            `SELECT tracks.title, artists.name AS artist, track_totals.plays
           FROM track_totals JOIN tracks ON tracks.id = track_totals.track_id
           JOIN artists ON artists.id = tracks.artist_id
           WHERE track_totals.user_id = ?1 ORDER BY track_totals.plays DESC, tracks.id LIMIT 10`,
          )
          .bind(...rangeBind)
          .all<TrackCount>()
      : await db
          .prepare(
            `SELECT tracks.title, artists.name AS artist, COUNT(*) AS plays
           FROM plays JOIN tracks ON tracks.id = plays.track_id
           JOIN artists ON artists.id = tracks.artist_id
           WHERE plays.user_id = ?1 AND plays.dup = 0${range}
           GROUP BY plays.track_id ORDER BY plays DESC, tracks.id LIMIT 10`,
          )
          .bind(...rangeBind)
          .all<TrackCount>();
  const artistRows =
    period === "all"
      ? await db
          .prepare(
            `SELECT artists.name AS artist, SUM(track_totals.plays) AS plays
           FROM track_totals JOIN tracks ON tracks.id = track_totals.track_id
           JOIN artists ON artists.id = tracks.artist_id
           WHERE track_totals.user_id = ?1 GROUP BY artists.id
           ORDER BY plays DESC, artists.id LIMIT 10`,
          )
          .bind(userId)
          .all<ArtistCount>()
      : await db
          .prepare(
            `SELECT artists.name AS artist, COUNT(*) AS plays
           FROM plays JOIN tracks ON tracks.id = plays.track_id
           JOIN artists ON artists.id = tracks.artist_id
           WHERE plays.user_id = ?1 AND plays.dup = 0${range}
           GROUP BY artists.id ORDER BY plays DESC, artists.id LIMIT 10`,
          )
          .bind(...rangeBind)
          .all<ArtistCount>();
  const totals =
    period === "all"
      ? await db
          .prepare(
            `SELECT SUM(track_totals.plays) AS plays, COUNT(*) AS unique_tracks,
           COUNT(DISTINCT tracks.artist_id) AS unique_artists
           FROM track_totals JOIN tracks ON tracks.id = track_totals.track_id
           WHERE track_totals.user_id = ?1`,
          )
          .bind(userId)
          .first<{
            plays: number | null;
            unique_tracks: number;
            unique_artists: number;
          }>()
      : await db
          .prepare(
            `SELECT COUNT(*) AS plays, COUNT(DISTINCT plays.track_id) AS unique_tracks,
           COUNT(DISTINCT tracks.artist_id) AS unique_artists
           FROM plays JOIN tracks ON tracks.id = plays.track_id
           WHERE plays.user_id = ?1 AND plays.dup = 0${range}`,
          )
          .bind(...rangeBind)
          .first<{
            plays: number;
            unique_tracks: number;
            unique_artists: number;
          }>();
  const daily = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', played_at, 'unixepoch') AS day, COUNT(*) AS plays
       FROM plays WHERE user_id = ?1 AND dup = 0${range}
       GROUP BY day ORDER BY day`,
    )
    .bind(...rangeBind)
    .all<DailyCount>();
  return {
    schema: 1,
    user: { name },
    period,
    from,
    to: now,
    plays: totals?.plays ?? 0,
    unique_tracks: totals?.unique_tracks ?? 0,
    unique_artists: totals?.unique_artists ?? 0,
    top_tracks: trackRows.results,
    top_artists: artistRows.results,
    daily: daily.results,
    updated_at: now,
  } satisfies PeriodStats;
}
