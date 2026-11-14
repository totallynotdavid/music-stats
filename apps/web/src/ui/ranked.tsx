export interface RankedItem {
  title: string;
  subtitle?: string;
  plays: number;
}

export function RankedList({ items }: { items: RankedItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.plays));
  return (
    <ol class="ranked">
      {items.map((item, index) => (
        <li key={`${item.title}-${item.subtitle ?? ""}`}>
          <span class="rank">{index + 1}</span>
          <span class="track">
            <b>{item.title}</b>
            {item.subtitle !== undefined && item.subtitle !== "" && (
              <small>{item.subtitle}</small>
            )}
          </span>
          <span class="count">{item.plays}</span>
          <span class="share" aria-hidden="true">
            <span style={`width: ${(item.plays / max) * 100}%`} />
          </span>
        </li>
      ))}
    </ol>
  );
}
