import type { Child } from "hono/jsx";

interface PageOptions {
  title: string;
  head?: Child;
  account?: Child;
  footer?: Child;
  children: Child;
}

export function page({ title, head, account, footer, children }: PageOptions) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {head}
        <link rel="stylesheet" href="/styles.css" />
        <title>{`${title} · Music stats`}</title>
      </head>
      <body>
        <header class="site-header">
          <div class="wrap">
            <a class="site-name" href="/">
              Music stats
            </a>
            {account && (
              <nav class="account" aria-label="Account">
                {account}
              </nav>
            )}
          </div>
        </header>
        <main class="wrap shell">{children}</main>
        {footer && <footer class="wrap footer">{footer}</footer>}
      </body>
    </html>
  );
}
