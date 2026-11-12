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

const bulkArtistSql = `
  INSERT OR IGNORE INTO artists (key, name, mbid)
  SELECT DISTINCT
    json_extract(value, '$.artistKey'),
    json_extract(value, '$.artist'),
    NULL
  FROM json_each(?1)
`;

const bulkTrackSql = `
  INSERT OR IGNORE INTO tracks (key, artist_id, title, mbid, isrc)
  SELECT
    json_extract(value, '$.key'),
    (SELECT id FROM artists WHERE key = json_extract(value, '$.artistKey')),
    json_extract(value, '$.title'),
    json_extract(value, '$.mbid'),
    json_extract(value, '$.isrc')
  FROM json_each(?1)
`;

const bulkAliasSql = `
  INSERT OR IGNORE INTO track_aliases (kind, source_key, track_id)
  SELECT
    ?2,
    json_extract(item.value, '$.sourceKey'),
    tracks.id
  FROM json_each(?1) AS item
  JOIN tracks ON tracks.key = json_extract(item.value, '$.trackKey')
`;

const bulkPlaySql = `
  INSERT OR IGNORE INTO plays (user_id, played_at, source_id, ref, track_id)
  SELECT
    json_extract(item.value, '$.userId'),
    json_extract(item.value, '$.listenedAt'),
    json_extract(item.value, '$.sourceId'),
    '',
    (
      SELECT track_id FROM track_aliases
      WHERE kind = ?2 AND source_key = json_extract(item.value, '$.sourceKey')
    )
  FROM json_each(?1) AS item
  WHERE EXISTS (
    SELECT 1 FROM track_aliases
    WHERE kind = ?2 AND source_key = json_extract(item.value, '$.sourceKey')
  )
  RETURNING 1 AS inserted
`;

function prepareFields(input: BulkListen): PreparedFields {
  const artistKey = normalizeText(input.artist, input.kind === "ytmusic");
  const titleKey = normalizeText(input.title);
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
  prepared: ReadonlyMap<BulkListen, PreparedFields>,
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
      const fields = prepared.get(input)!;
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

export function resolvePageTracks(
  inputs: BulkListen[],
  aliases: ReadonlyMap<string, ExistingTrack>,
  existingTracks: readonly ExistingTrack[],
) {
  const prepared = new Map(
    inputs.map((input) => [input, prepareFields(input)]),
  );
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

export async function storeListens(
  db: D1Database,
  inputs: BulkListen[],
  kind: string,
) {
  if (inputs.length === 0) return 0;
  const existing = await readAliases(db, inputs, kind);
  const prepared = new Map<BulkListen, PreparedFields>();
  const candidates: Array<{
    normalizedKey: string;
    mbid: string | null;
    isrc: string | null;
  }> = [];
  for (const input of inputs) {
    if (existing.aliases.has(input.sourceKey)) continue;
    const fields = prepareFields(input);
    prepared.set(input, fields);
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
  const resolution = resolvePage(inputs, prepared, existing.aliases, [
    ...existing.tracks.values(),
  ]);
  const newTracksPayload = JSON.stringify(resolution.newTracks);
  const listensPayload = JSON.stringify(resolution.listens);
  const results = await db.batch([
    db.prepare(bulkArtistSql).bind(newTracksPayload),
    db.prepare(bulkTrackSql).bind(newTracksPayload),
    db.prepare(bulkAliasSql).bind(listensPayload, kind),
    db.prepare(bulkPlaySql).bind(listensPayload, kind),
  ]);
  return results[3]?.results?.length ?? 0;
}
