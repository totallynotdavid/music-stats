import type { Child } from "hono/jsx";

export type PillVariant = "default" | "primary" | "danger";

interface PillLinkOptions {
  href: string;
  variant?: PillVariant;
  id?: string;
  small?: boolean;
  dataName?: string;
  children: Child;
}

export function PillLink({
  href,
  variant = "default",
  id,
  small,
  dataName,
  children,
}: PillLinkOptions) {
  const cls = `pill${variant === "default" ? "" : ` ${variant}`}${small ? " small" : ""}`;
  return (
    <a class={cls} href={href} id={id} data-name={dataName}>
      {children}
    </a>
  );
}

interface PillButtonOptions {
  variant?: PillVariant;
  type?: "submit" | "button";
  small?: boolean;
  children: Child;
}

export function PillButton({
  variant = "default",
  type = "submit",
  small,
  children,
}: PillButtonOptions) {
  const cls = `pill${variant === "default" ? "" : ` ${variant}`}${small ? " small" : ""}`;
  return (
    <button class={cls} type={type}>
      {children}
    </button>
  );
}
