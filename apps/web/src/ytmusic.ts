import { ingestPage, type PagePlay, type PageSource } from "./ingest";
import { openSecret } from "./secret";
import type { Env, SourceRow } from "./types";
import {
  fetchHistoryPage,
  HistoryPageError,
  parseHistoryPage,
  SignedOutError,
  todayIn,
  type YouTubeFetcher,
} from "./youtube";

// The page holds about 200 plays, roughly ten hours of continuous listening,
// so an hourly pull keeps a tenfold margin for 24 fetches a day.
export const pullIntervalSeconds = 3600;

const signedOutMessage = "YouTube signed you out. Paste a new cookie.";
const parseMessage =
  "The YouTube Music history page did not parse. Paste a new cookie.";

function toPagePlays(plays: ReturnType<typeof parseHistoryPage>) {
  const accepted: PagePlay[] = [];
  for (const play of plays) {
    if (play.day === null || play.videoId === null) continue;
    if ([...play.title].length > 512 || [...play.artist].length > 512) continue;
    accepted.push({
      day: play.day,
      artist: play.artist,
      title: play.title,
      video_id: play.videoId,
    });
  }
  return accepted;
}

async function stopPulls(db: D1Database, sourceId: number, error: string) {
  await db
    .prepare(
      `UPDATE sources SET status = 'error', error = ?1, next_pull_at = NULL
       WHERE id = ?2`,
    )
    .bind(error, sourceId)
    .run();
}

export async function pullYouTube(
  env: Env,
  source: SourceRow,
  fetcher: YouTubeFetcher = fetch,
  now = Math.floor(Date.now() / 1000),
) {
  const page = source as PageSource;
  if (!source.secret) {
    await stopPulls(env.DB, source.id, signedOutMessage);
    return { inserted: 0 };
  }
  const cookie = await openSecret(env, source.secret);
  const html = await fetchHistoryPage(cookie, fetcher, now);

  const today = todayIn(now, source.tz ?? "UTC");
  let plays;
  try {
    plays = parseHistoryPage(html, today);
  } catch (error) {
    if (error instanceof SignedOutError) {
      await stopPulls(env.DB, source.id, signedOutMessage);
      return { inserted: 0 };
    }
    if (error instanceof HistoryPageError) {
      await stopPulls(env.DB, source.id, parseMessage);
      return { inserted: 0 };
    }
    throw error;
  }

  const result = await ingestPage(env.DB, page, toPagePlays(plays), {
    now,
    pullNextAt: now + pullIntervalSeconds,
  });
  return { inserted: result.inserted };
}
