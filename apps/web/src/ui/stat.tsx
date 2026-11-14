export interface StatItem {
  label: string;
  value: number;
}

export function Stats({ items }: { items: StatItem[] }) {
  return (
    <dl class="stats">
      {items.map((item) => (
        <div class="stat" key={item.label}>
          <dt class="label">{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
