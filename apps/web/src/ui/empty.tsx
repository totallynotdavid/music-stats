import type { Child } from "hono/jsx";

interface EmptyStateOptions {
  title: string;
  body?: Child;
  action?: { href: string; label: string };
  heading?: "h1" | "p";
}

export function EmptyState({
  title,
  body,
  action,
  heading = "p",
}: EmptyStateOptions) {
  const Title = heading;
  return (
    <div class="empty">
      <Title class="empty-title">{title}</Title>
      {body && <p>{body}</p>}
      {action && (
        <a class="pill" href={action.href}>
          {action.label}
        </a>
      )}
    </div>
  );
}
