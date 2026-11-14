import type { Env } from "../types";
import { FeedError } from "./http";
import {
  appleChart,
  deezerChart,
  deezerPlaylist,
  type Candidate,
} from "./sources";

export interface Category {
  slug: string;
  name: string;
  feed: "deezer_chart" | "deezer_playlist" | "apple_chart" | "mine";
  ref: string | null;
}

const catalogTtlSeconds = 6 * 3600;

export function listCategories(db: D1Database) {
  return db
    .prepare("SELECT slug, name, feed, ref FROM categories ORDER BY rowid")
    .all<Category>()
    .then((result) => result.results);
}

export async function getCategory(db: D1Database, slug: string) {
  return db
    .prepare("SELECT slug, name, feed, ref FROM categories WHERE slug = ?1")
    .bind(slug)
    .first<Category>();
}

export { FeedError };

async function userCatalog(db: D1Database, userId: number) {
  const result = await db
    .prepare(
      `SELECT tracks.title, artists.name AS artist, tracks.isrc
       FROM track_totals
       JOIN tracks ON tracks.id = track_totals.track_id
       JOIN artists ON artists.id = tracks.artist_id
       WHERE track_totals.user_id = ?1
       ORDER BY track_totals.plays DESC
       LIMIT 40`,
    )
    .bind(userId)
    .all<{ title: string; artist: string; isrc: string | null }>();
  return result.results.map((row) => ({
    title: row.title,
    artist: row.artist,
    cover: null,
    link: null,
    isrc: row.isrc ?? undefined,
  }));
}

export async function catalog(
  env: Env,
  category: Category,
  userId: number | null,
): Promise<Candidate[]> {
  if (category.feed === "mine") {
    if (userId === null) throw new FeedError("sign-in required", category.slug);
    return userCatalog(env.DB, userId);
  }
  const key = `play:cat:${category.slug}`;
  const cached = await env.CACHE?.get<Candidate[]>(key, "json").catch(
    () => null,
  );
  if (cached && cached.length > 0) return cached;
  let tracks: Candidate[];
  if (category.feed === "deezer_chart")
    tracks = await deezerChart(category.ref ?? "0");
  else if (category.feed === "deezer_playlist")
    tracks = await deezerPlaylist(category.ref ?? "0");
  else tracks = await appleChart(category.ref ?? "us");
  if (env.CACHE && tracks.length > 0)
    await env.CACHE.put(key, JSON.stringify(tracks), {
      expirationTtl: catalogTtlSeconds,
    }).catch(() => undefined);
  return tracks;
}
