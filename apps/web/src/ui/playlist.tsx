export interface PlaylistEntry {
  trackId: number;
  title: string;
  artist: string;
  names: string[];
}

export function Playlist({ items }: { items: PlaylistEntry[] }) {
  return (
    <ol class="ranked">
      {items.map((item, index) => (
        <li key={item.trackId}>
          <span class="rank">{index + 1}</span>
          <span class="track">
            <b>{item.title}</b>
            <small>
              {item.artist} · {item.names.join(" + ")}
            </small>
          </span>
        </li>
      ))}
    </ol>
  );
}
