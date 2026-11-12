declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    LISTENBRAINZ_BASE_URL: string;
    LASTFM_APPROVAL: string;
    LASTFM_BASE_URL?: string;
    LASTFM_API_KEY?: string;
  }
}

declare module "virtual:web-migrations" {
  const migrations: Array<{ name: string; queries: string[] }>;
  export default migrations;
}
