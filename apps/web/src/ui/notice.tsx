import type { Child } from "hono/jsx";

export function Notice({ children }: { children: Child }) {
  return <p class="notice">{children}</p>;
}
