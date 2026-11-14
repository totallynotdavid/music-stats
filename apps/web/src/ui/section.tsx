import type { Child } from "hono/jsx";

interface SectionOptions {
  title: string;
  aside?: Child;
  children: Child;
}

export function Section({ title, aside, children }: SectionOptions) {
  return (
    <section class="section">
      <div class="section-head">
        <h2>{title}</h2>
        {aside && <small class="label">{aside}</small>}
      </div>
      <div class="section-body">{children}</div>
    </section>
  );
}
