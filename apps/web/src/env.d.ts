declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    SPOTIFY_CLIENT_ID?: string;
    SPOTIFY_CLIENT_SECRET?: string;
    SPOTIFY_ENCRYPTION_KEY?: string;
  }
}

declare module "virtual:web-migrations" {
  const migrations: Array<{ name: string; queries: string[] }>;
  export default migrations;
}
