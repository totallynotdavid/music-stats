import { alignPage, type Alignment, type PagePair } from "./align";
import { markDuplicates } from "./duplicates";
import {
  aliasInsertRows,
  artistInsertRows,
  bulkAliasSql,
  bulkArtistSql,
  bulkTrackSql,
  resolveStoredPage,
  type PageResolution,
} from "./matching";

export interface PageSource {
  id: number;
  user_id: number;
  status: string;
  last_page: string | null;
  play_seq: number;
  gap_at: number | null;
}

export interface PagePlay {
  day: string;
  artist: string;
  title: string;
  video_id: string;
}

export interface IngestOptions {
  now: number;
  pullNextAt?: number;
  extra?: D1PreparedStatement[];
}

export interface IngestResult {
  received: number;
  inserted: number;
  gap: boolean;
  ambiguous: number;
  replay: boolean;
  raced: boolean;
}

const writePlaySql = `
  INSERT OR IGNORE INTO plays (user_id, played_at, source_id, ref, track_id)
  SELECT
    json_extract(item.value, '$.userId'),
    json_extract(item.value, '$.listenedAt'),
    json_extract(item.value, '$.sourceId'),
    json_extract(item.value, '$.ref'),
    (SELECT id FROM tracks WHERE key = json_extract(item.value, '$.trackKey'))
  FROM json_each(?1) AS item
  WHERE (SELECT play_seq FROM sources WHERE id = ?2) = ?3
`;

const uploadSourceSql = `
  UPDATE sources SET
    last_page = ?1,
    play_seq = play_seq + ?2,
    maybe_missing = maybe_missing + ?3,
    status = ?4,
    gap_at = ?5,
    last_ok_at = ?6
  WHERE id = ?7 AND play_seq = ?8
`;

const pullSourceSql = `
  UPDATE sources SET
    last_page = ?1,
    play_seq = play_seq + ?2,
    maybe_missing = maybe_missing + ?3,
    status = ?4,
    gap_at = ?5,
    next_pull_at = ?6,
    error = NULL,
    idle_pulls = 0,
    play_count = play_count + ?2
  WHERE id = ?7 AND play_seq = ?8
`;

const pullReplaySql = `
  UPDATE sources SET
    next_pull_at = ?1,
    error = NULL,
    idle_pulls = 0,
    status = CASE WHEN status = 'error' THEN 'active' ELSE status END
  WHERE id = ?2
`;

export function uploadListenedAt(play: PagePlay) {
  return Date.parse(`${play.day}T12:00:00.000Z`) / 1000;
}

function touchSource(
  db: D1Database,
  source: PageSource,
  options: IngestOptions,
) {
  if (options.pullNextAt !== undefined)
    return db.prepare(pullReplaySql).bind(options.pullNextAt, source.id);
  return db
    .prepare("UPDATE sources SET last_ok_at = ?1 WHERE id = ?2")
    .bind(options.now, source.id);
}

function pageDayRange(plays: PagePlay[]): [number, number] {
  const times = plays.map(uploadListenedAt);
  return [Math.min(...times), Math.max(...times)];
}

async function resolvePage(
  db: D1Database,
  source: PageSource,
  added: PagePlay[],
): Promise<PageResolution> {
  const inputs = added
    .map((play) => ({
      kind: "ytmusic",
      sourceKey: play.video_id,
      artist: play.artist,
      title: play.title,
      listenedAt: uploadListenedAt(play),
      userId: source.user_id,
      sourceId: source.id,
    }))
    .reverse();
  const empty: PageResolution = { listens: [], newTracks: [] };
  if (inputs.length === 0) return empty;
  return resolveStoredPage(db, inputs, "ytmusic");
}

function sourceUpdate(
  db: D1Database,
  source: PageSource,
  alignment: Alignment,
  added: number,
  pageJson: string,
  options: IngestOptions,
) {
  const gapAt = alignment.gap ? options.now : source.gap_at;
  if (options.pullNextAt !== undefined)
    return db
      .prepare(pullSourceSql)
      .bind(
        pageJson,
        added,
        alignment.ambiguous,
        alignment.gap ? "gap" : "active",
        gapAt,
        options.pullNextAt,
        source.id,
        source.play_seq,
      );
  return db
    .prepare(uploadSourceSql)
    .bind(
      pageJson,
      added,
      alignment.ambiguous,
      alignment.gap ? "gap" : "active",
      gapAt,
      options.now,
      source.id,
      source.play_seq,
    );
}

// The store, gap and duplicate step shared by an upload and a pull: align the
// page against the last accepted one, write the new plays in one batch guarded
// by play_seq, then pair duplicates over the span the page touched.
export async function ingestPage(
  db: D1Database,
  source: PageSource,
  plays: PagePlay[],
  options: IngestOptions,
): Promise<IngestResult> {
  const pairs: PagePair[] = plays.map((play) => [play.day, play.video_id]);
  const pageJson = JSON.stringify(pairs);
  const extra = options.extra ?? [];

  // An empty page proves nothing about alignment, duplicates or gaps, so it
  // only reschedules the source; alignPage would read a negative run from it.
  if (plays.length === 0) {
    await db.batch([touchSource(db, source, options), ...extra]);
    return {
      received: 0,
      inserted: 0,
      gap: source.status === "gap",
      ambiguous: 0,
      replay: false,
      raced: false,
    };
  }

  if (source.last_page === pageJson) {
    await markDuplicates(db, source.user_id, ...pageDayRange(plays));
    await db.batch([touchSource(db, source, options), ...extra]);
    return {
      received: plays.length,
      inserted: 0,
      gap: source.status === "gap",
      ambiguous: 0,
      replay: true,
      raced: false,
    };
  }

  const previous =
    source.last_page === null
      ? null
      : (JSON.parse(source.last_page) as PagePair[]);
  const alignment = alignPage(previous, pairs);
  const added = plays.slice(0, alignment.newCount);
  const { listens, newTracks } = await resolvePage(db, source, added);

  const statements: D1PreparedStatement[] = [];
  if (newTracks.length > 0) {
    statements.push(
      db.prepare(bulkArtistSql).bind(artistInsertRows(newTracks)),
      db.prepare(bulkTrackSql).bind(JSON.stringify(newTracks)),
    );
  }
  let playsIndex = -1;
  if (listens.length > 0) {
    statements.push(
      db.prepare(bulkAliasSql).bind(aliasInsertRows(listens), "ytmusic"),
      db.prepare(writePlaySql).bind(
        JSON.stringify(
          listens.map((listen, index) => ({
            ...listen,
            ref: `${listen.sourceKey}#${source.play_seq + index + 1}`,
          })),
        ),
        source.id,
        source.play_seq,
      ),
    );
    playsIndex = statements.length - 1;
  }
  const updateIndex = statements.length;
  statements.push(
    sourceUpdate(db, source, alignment, listens.length, pageJson, options),
    ...extra,
  );

  const results = await db.batch(statements);
  if ((results[updateIndex]?.meta?.changes ?? 0) === 0)
    return {
      received: plays.length,
      inserted: 0,
      gap: alignment.gap,
      ambiguous: alignment.ambiguous,
      replay: false,
      raced: true,
    };

  const times =
    listens.length > 0
      ? listens.map((listen) => listen.listenedAt)
      : pageDayRange(plays);
  await markDuplicates(
    db,
    source.user_id,
    Math.min(...times),
    Math.max(...times),
  );
  return {
    received: plays.length,
    inserted: playsIndex >= 0 ? listens.length : 0,
    gap: alignment.gap,
    ambiguous: alignment.ambiguous,
    replay: false,
    raced: false,
  };
}
