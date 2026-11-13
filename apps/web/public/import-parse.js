const spotifyUriPattern = /^spotify:track:[A-Za-z0-9]{22}$/;
const videoIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const earliestPlay = Date.parse("2005-01-01T00:00:00.000Z") / 1000;

function endOfTomorrow(now) {
  return (Math.floor(now / 86400) + 2) * 86400;
}

function skipped(skips, reason) {
  skips.set(reason, (skips.get(reason) ?? 0) + 1);
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

export function spotifyPlays(records, now = Date.now() / 1000) {
  const plays = [];
  const skips = new Map();
  for (const record of records) {
    if (
      !isRecord(record) ||
      !spotifyUriPattern.test(record.spotify_track_uri)
    ) {
      skipped(skips, "not a streamable track");
      continue;
    }
    if (
      typeof record.master_metadata_track_name !== "string" ||
      record.master_metadata_track_name.length === 0 ||
      typeof record.master_metadata_album_artist_name !== "string" ||
      record.master_metadata_album_artist_name.length === 0
    ) {
      skipped(skips, "missing a track or artist name");
      continue;
    }
    if (typeof record.ms_played !== "number" || record.ms_played < 30000) {
      skipped(skips, "played under 30 seconds");
      continue;
    }
    if (record.incognito_mode === true) {
      skipped(skips, "a private session");
      continue;
    }
    const at = Math.floor((Date.parse(record.ts) - record.ms_played) / 1000);
    if (!Number.isFinite(at) || at < earliestPlay || at >= endOfTomorrow(now)) {
      skipped(skips, "an unreadable time");
      continue;
    }
    plays.push({
      at,
      id: record.spotify_track_uri.slice("spotify:track:".length),
      artist: record.master_metadata_album_artist_name,
      title: record.master_metadata_track_name,
    });
  }
  return { plays, skips };
}

export function takeoutPlays(records, now = Date.now() / 1000) {
  const plays = [];
  const skips = new Map();
  for (const record of records) {
    if (!isRecord(record) || record.header !== "YouTube Music") {
      skipped(skips, "not a YouTube Music record");
      continue;
    }
    let id = null;
    try {
      const url = new URL(record.titleUrl);
      if (url.hostname === "music.youtube.com" && url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        if (v !== null && videoIdPattern.test(v)) id = v;
      }
    } catch {
      id = null;
    }
    if (id === null) {
      skipped(skips, "a removed or unknown video");
      continue;
    }
    const title =
      typeof record.title === "string" && record.title.startsWith("Watched ")
        ? record.title.slice("Watched ".length)
        : "";
    const channel = record.subtitles?.[0]?.name;
    if (title.length === 0 || typeof channel !== "string" || channel === "") {
      skipped(skips, "missing a title or channel");
      continue;
    }
    const at = Math.floor(Date.parse(record.time) / 1000);
    if (!Number.isFinite(at) || at < earliestPlay || at >= endOfTomorrow(now)) {
      skipped(skips, "outside the allowed dates");
      continue;
    }
    plays.push({ at, id, artist: channel, title });
  }
  return { plays, skips };
}

export function detectKind(records) {
  const first = records[0];
  if (!isRecord(first)) return null;
  if ("ms_played" in first && "spotify_track_uri" in first) return "spotify";
  if ("header" in first && "title" in first) return "ytmusic";
  return null;
}
