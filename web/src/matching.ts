import { normalizeText } from "./normalize";
import type { TrackInput } from "./types";

interface BulkListen extends TrackInput {
  listenedAt: number;
  userId: number;
  sourceId: number;
}

interface PreparedFields {
  artistKey: string;
  titleKey: string;
  normalizedKey: string;
}

export interface ExistingTrack {
  id: number;
  key: string;
  mbid: string | null;
  isrc: string | null;
  artistKey: string;
  titleKey: string;
}

interface WalkTrack extends Omit<ExistingTrack, "id"> {
  id: number | null;
  artist: string;
  title: string;
}

export interface ResolvedListen {
  sourceKey: string;
  trackKey: string;
  listenedAt: number;
  userId: number;
  sourceId: number;
}

export interface NewTrack {
  key: string;
  artistKey: string;
  artist: string;
  title: string;
  mbid: string | null;
  isrc: string | null;
}

export interface PageResolution {
  listens: ResolvedListen[];
  newTracks: NewTrack[];
}

const readAliasSql = `
  WITH page AS (
    SELECT DISTINCT value AS source_key
    FROM json_each(?1)
  )
  SELECT aliases.source_key,
    tracks.id,
    tracks.key,
    tracks.mbid,
    tracks.isrc,
    artists.key AS artistKey,
    substr(tracks.key, instr(tracks.key, char(31)) + 1) AS titleKey
  FROM track_aliases AS aliases
  JOIN page ON page.source_key = aliases.source_key
  JOIN tracks ON tracks.id = aliases.track_id
  JOIN artists ON artists.id = tracks.artist_id
  WHERE aliases.kind = ?2
  ORDER BY tracks.id
`;

export const readTrackSql = `
  SELECT * FROM (
  SELECT DISTINCT
    tracks.id,
    tracks.key,
    tracks.mbid,
    tracks.isrc,
    artists.key AS artistKey,
    substr(tracks.key, instr(tracks.key, char(31)) + 1) AS titleKey
  FROM tracks
  JOIN (
    SELECT DISTINCT json_extract(value, '$.normalizedKey') AS k
    FROM json_each(?1)
    WHERE json_extract(value, '$.normalizedKey') IS NOT NULL
  ) AS page ON tracks.key = page.k
  JOIN artists ON artists.id = tracks.artist_id
  UNION
  SELECT DISTINCT
    tracks.id,
    tracks.key,
    tracks.mbid,
    tracks.isrc,
    artists.key AS artistKey,
    substr(tracks.key, instr(tracks.key, char(31)) + 1) AS titleKey
  FROM tracks
  JOIN (
    SELECT DISTINCT json_extract(value, '$.mbid') AS k
    FROM json_each(?1)
    WHERE json_extract(value, '$.mbid') IS NOT NULL
  ) AS page ON tracks.mbid = page.k
  JOIN artists ON artists.id = tracks.artist_id
  UNION
  SELECT DISTINCT
    tracks.id,
    tracks.key,
    tracks.mbid,
    tracks.isrc,
    artists.key AS artistKey,
    substr(tracks.key, instr(tracks.key, char(31)) + 1) AS titleKey
  FROM tracks
  JOIN (
    SELECT DISTINCT json_extract(value, '$.isrc') AS k
    FROM json_each(?1)
    WHERE json_extract(value, '$.isrc') IS NOT NULL
  ) AS page ON tracks.isrc = page.k
  JOIN artists ON artists.id = tracks.artist_id
  ) AS candidates
  ORDER BY id
`;

export const bulkArtistSql = `
  INSERT OR IGNORE INTO artists (key, name, mbid)
  SELECT json_extract(value, '$.k'), json_extract(value, '$.a'), NULL
  FROM json_each(?1)
`;

export const bulkTrackSql = `
  INSERT OR IGNORE INTO tracks (key, artist_id, title, mbid, isrc)
  SELECT
    json_extract(value, '$.key'),
    (SELECT id FROM artists WHERE key = json_extract(value, '$.artistKey')),
    json_extract(value, '$.title'),
    json_extract(value, '$.mbid'),
    json_extract(value, '$.isrc')
  FROM json_each(?1)
`;

export const bulkAliasSql = `
  INSERT OR IGNORE INTO track_aliases (kind, source_key, track_id)
  SELECT
    ?2,
    json_extract(item.value, '$.s'),
    tracks.id
  FROM json_each(?1) AS item
  JOIN tracks ON tracks.key = json_extract(item.value, '$.t')
`;

const bulkPlaySql = `
  INSERT OR IGNORE INTO plays (user_id, played_at, source_id, ref, track_id)
  SELECT
    json_extract(item.value, '$.u'),
    json_extract(item.value, '$.at'),
    json_extract(item.value, '$.s'),
    '',
    tracks.id
  FROM json_each(?1) AS item
  JOIN tracks ON tracks.key = json_extract(item.value, '$.k')
  RETURNING 1 AS inserted
`;

export function artistInsertRows(newTracks: NewTrack[]) {
  const artists = new Map<string, string>();
  for (const track of newTracks)
    if (!artists.has(track.artistKey))
      artists.set(track.artistKey, track.artist);
  return JSON.stringify([...artists].map(([k, a]) => ({ k, a })));
}

export function aliasInsertRows(listens: ResolvedListen[]) {
  const seen = new Set<string>();
  const rows = [];
  for (const listen of listens) {
    if (seen.has(listen.sourceKey)) continue;
    seen.add(listen.sourceKey);
    rows.push({ s: listen.sourceKey, t: listen.trackKey });
  }
  return JSON.stringify(rows);
}

interface NormalizeCache {
  artists: Map<string, string>;
  titles: Map<string, string>;
}

const newCache = (): NormalizeCache => ({
  artists: new Map(),
  titles: new Map(),
});

function normalizeCached(
  cache: Map<string, string>,
  raw: string,
  removeTopic: boolean,
) {
  let key = cache.get(raw);
  if (key === undefined) {
    key = normalizeText(raw, removeTopic);
    cache.set(raw, key);
  }
  return key;
}

function prepareFields(
  input: BulkListen,
  cache: NormalizeCache,
): PreparedFields {
  const artistKey = normalizeCached(
    cache.artists,
    input.artist,
    input.kind === "ytmusic",
  );
  const titleKey = normalizeCached(cache.titles, input.title, false);
  return {
    artistKey,
    titleKey,
    normalizedKey: artistKey + "\u001f" + titleKey,
  };
}

function sameIdentifier(
  fields: PreparedFields,
  track: Pick<WalkTrack, "artistKey" | "titleKey">,
) {
  return (
    fields.artistKey === track.artistKey || fields.titleKey === track.titleKey
  );
}

function asWalkTrack(track: ExistingTrack): WalkTrack {
  return { ...track, artist: "", title: "" };
}

function resolvePage(
  inputs: readonly BulkListen[],
  prepared: ReadonlyMap<string, PreparedFields>,
  aliases: ReadonlyMap<string, ExistingTrack>,
  existingTracks: readonly ExistingTrack[],
): PageResolution {
  const byKey = new Map<string, WalkTrack>();
  const byMbid = new Map<string, WalkTrack[]>();
  const byIsrc = new Map<string, WalkTrack[]>();
  const loadedTracks = new Map<number, WalkTrack>();

  const addIdentifier = (
    index: Map<string, WalkTrack[]>,
    value: string | null,
    track: WalkTrack,
  ) => {
    if (!value) return;
    const candidates = index.get(value);
    if (candidates) candidates.push(track);
    else index.set(value, [track]);
  };

  const addTrack = (track: WalkTrack) => {
    byKey.set(track.key, track);
    addIdentifier(byMbid, track.mbid, track);
    addIdentifier(byIsrc, track.isrc, track);
  };

  for (const track of existingTracks) {
    loadedTracks.set(track.id, asWalkTrack(track));
  }
  for (const track of aliases.values()) {
    loadedTracks.set(track.id, asWalkTrack(track));
  }
  for (const track of loadedTracks.values()) addTrack(track);

  const newTracks = new Map<string, NewTrack>();
  const pageAliases = new Map<string, WalkTrack>();
  const resolved: ResolvedListen[] = [];

  for (const input of inputs) {
    let track: WalkTrack | undefined;
    const aliasedTrack = aliases.get(input.sourceKey);
    if (aliasedTrack) track = asWalkTrack(aliasedTrack);
    if (!track) track = pageAliases.get(input.sourceKey);
    if (!track) {
      const fields = prepared.get(input.sourceKey)!;
      const mbidCandidates = input.mbid ? byMbid.get(input.mbid) : undefined;
      track = mbidCandidates?.find((candidate) =>
        sameIdentifier(fields, candidate),
      );
      if (!track) {
        const isrcCandidates = input.isrc ? byIsrc.get(input.isrc) : undefined;
        track = isrcCandidates?.find((candidate) =>
          sameIdentifier(fields, candidate),
        );
      }
      if (!track) track = byKey.get(fields.normalizedKey);
      if (!track) {
        const newTrack: WalkTrack = {
          id: null,
          key: fields.normalizedKey,
          mbid: input.mbid ?? null,
          isrc: input.isrc ?? null,
          artistKey: fields.artistKey,
          titleKey: fields.titleKey,
          artist: input.artist,
          title: input.title,
        };
        track = newTrack;
        addTrack(track);
        newTracks.set(track.key, {
          key: track.key,
          artistKey: track.artistKey,
          artist: track.artist,
          title: track.title,
          mbid: track.mbid,
          isrc: track.isrc,
        });
      }
    }

    addIdentifier(byMbid, input.mbid ?? null, track);
    addIdentifier(byIsrc, input.isrc ?? null, track);
    pageAliases.set(input.sourceKey, track);
    resolved.push({
      sourceKey: input.sourceKey,
      trackKey: track.key,
      listenedAt: input.listenedAt,
      userId: input.userId,
      sourceId: input.sourceId,
    });
  }

  return { listens: resolved, newTracks: [...newTracks.values()] };
}

function preparePage(
  inputs: readonly BulkListen[],
  skip: ReadonlySet<string>,
  cache: NormalizeCache,
) {
  const prepared = new Map<string, PreparedFields>();
  for (const input of inputs) {
    if (skip.has(input.sourceKey) || prepared.has(input.sourceKey)) continue;
    prepared.set(input.sourceKey, prepareFields(input, cache));
  }
  return prepared;
}

export function resolvePageTracks(
  inputs: BulkListen[],
  aliases: ReadonlyMap<string, ExistingTrack>,
  existingTracks: readonly ExistingTrack[],
) {
  const prepared = preparePage(inputs, new Set(), newCache());
  return resolvePage(inputs, prepared, aliases, existingTracks);
}

async function readAliases(db: D1Database, inputs: BulkListen[], kind: string) {
  const payload = JSON.stringify(inputs.map((input) => input.sourceKey));
  const rows = (
    await db
      .prepare(readAliasSql)
      .bind(payload, kind)
      .all<ExistingTrack & { source_key: string }>()
  ).results;
  const aliases = new Map<string, ExistingTrack>();
  const tracks = new Map<number, ExistingTrack>();
  for (const row of rows) {
    aliases.set(row.source_key, row);
    tracks.set(row.id, row);
  }
  return { aliases, tracks };
}

export async function resolveStoredPage(
  db: D1Database,
  inputs: BulkListen[],
  kind: string,
): Promise<PageResolution> {
  const existing = await readAliases(db, inputs, kind);
  const prepared = preparePage(
    inputs,
    new Set(existing.aliases.keys()),
    newCache(),
  );
  const candidates: Array<{
    normalizedKey: string;
    mbid: string | null;
    isrc: string | null;
  }> = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const fields = prepared.get(input.sourceKey);
    if (!fields || seen.has(input.sourceKey)) continue;
    seen.add(input.sourceKey);
    candidates.push({
      normalizedKey: fields.normalizedKey,
      mbid: input.mbid ?? null,
      isrc: input.isrc ?? null,
    });
  }
  if (candidates.length > 0) {
    const rows = (
      await db
        .prepare(readTrackSql)
        .bind(JSON.stringify(candidates))
        .all<ExistingTrack>()
    ).results;
    for (const row of rows) existing.tracks.set(row.id, row);
  }
  return resolvePage(inputs, prepared, existing.aliases, [
    ...existing.tracks.values(),
  ]);
}

export interface StoreResult {
  inserted: number;
  rowsWritten: number;
}

export async function storeListens(
  db: D1Database,
  inputs: BulkListen[],
  kind: string,
): Promise<StoreResult> {
  const empty = { inserted: 0, rowsWritten: 0 };
  if (inputs.length === 0) return empty;
  const resolution = await resolveStoredPage(db, inputs, kind);
  const statements: D1PreparedStatement[] = [];
  if (resolution.newTracks.length > 0) {
    statements.push(
      db.prepare(bulkArtistSql).bind(artistInsertRows(resolution.newTracks)),
      db.prepare(bulkTrackSql).bind(JSON.stringify(resolution.newTracks)),
    );
  }
  const playRows = JSON.stringify(
    resolution.listens.map((listen) => ({
      u: listen.userId,
      at: listen.listenedAt,
      s: listen.sourceId,
      k: listen.trackKey,
    })),
  );
  statements.push(
    db.prepare(bulkAliasSql).bind(aliasInsertRows(resolution.listens), kind),
    db.prepare(bulkPlaySql).bind(playRows),
  );
  const results = await db.batch(statements);
  const rowsWritten = results.reduce(
    (sum, result) => sum + (result.meta?.rows_written ?? 0),
    0,
  );
  return {
    inserted: results.at(-1)?.results?.length ?? 0,
    rowsWritten,
  };
}
