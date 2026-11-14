export interface PartyCandidate {
  trackId: number;
  title: string;
  artist: string;
  artistKey: string;
  videoId: string | null;
  plays: number;
}

export interface PartyUser {
  name: string;
  tracks: PartyCandidate[];
}

export interface PartyTrack {
  trackId: number;
  title: string;
  artist: string;
  names: string[];
  videoId: string | null;
}

interface Entry {
  track: PartyCandidate;
  holders: number[];
  plays: number;
}

// An artist may not sit in the previous three slots, so the same artist is at
// least four positions apart when any remaining candidate allows it.
const artistGap = 3;

export function blend(users: PartyUser[], length: number): PartyTrack[] {
  const byTrack = new Map<number, Entry>();
  users.forEach((user, index) => {
    for (const track of user.tracks) {
      const entry = byTrack.get(track.trackId);
      if (entry === undefined)
        byTrack.set(track.trackId, {
          track,
          holders: [index],
          plays: track.plays,
        });
      else {
        entry.holders.push(index);
        entry.plays += track.plays;
      }
    }
  });

  const shared = [...byTrack.values()]
    .filter((entry) => entry.holders.length > 1)
    .sort(
      (a, b) =>
        b.holders.length - a.holders.length ||
        b.plays - a.plays ||
        a.track.trackId - b.track.trackId,
    );
  const queues = users.map((user) =>
    user.tracks
      .filter((track) => byTrack.get(track.trackId)?.holders.length === 1)
      .map((track) => byTrack.get(track.trackId) as Entry),
  );

  const items: PartyTrack[] = [];
  const recent: string[] = [];
  const place = (entry: Entry) => {
    items.push({
      trackId: entry.track.trackId,
      title: entry.track.title,
      artist: entry.track.artist,
      names: entry.holders.map((index) => users[index].name),
      videoId: entry.track.videoId,
    });
    recent.push(entry.track.artistKey);
    if (recent.length > artistGap) recent.shift();
  };

  while (items.length < length && shared.length > 0) {
    const index = shared.findIndex(
      (entry) => !recent.includes(entry.track.artistKey),
    );
    place(shared.splice(index < 0 ? 0 : index, 1)[0]);
  }
  while (items.length < length) {
    let placed = false;
    for (const queue of queues) {
      if (items.length >= length) break;
      const index = queue.findIndex(
        (entry) => !recent.includes(entry.track.artistKey),
      );
      if (index >= 0) {
        place(queue.splice(index, 1)[0]);
        placed = true;
      }
    }
    if (items.length >= length) break;
    if (!placed) {
      const queue = queues.find((item) => item.length > 0);
      if (queue === undefined) break;
      place(queue.shift() as Entry);
    }
  }
  return items;
}

// watch_videos answers 303 with an anonymous playlist (list=TL...) and needs
// no sign-in; it takes at most 50 video ids, measured 2026-11-14.
export function youtubePlaylistUrl(items: PartyTrack[]) {
  const ids = items
    .map((item) => item.videoId)
    .filter((id): id is string => id !== null)
    .slice(0, 50);
  if (ids.length === 0) return null;
  return `https://www.youtube.com/watch_videos?video_ids=${ids.join(",")}`;
}
