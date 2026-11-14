export interface SegmentOption {
  label: string;
  href: string;
  current: boolean;
}

export function Segmented({
  label,
  options,
}: {
  label: string;
  options: SegmentOption[];
}) {
  return (
    <nav class="segmented" aria-label={label}>
      {options.map((option) => (
        <a
          href={option.href}
          aria-current={option.current ? "page" : undefined}
        >
          {option.label}
        </a>
      ))}
    </nav>
  );
}
