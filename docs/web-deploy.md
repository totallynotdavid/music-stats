# Web deployment

The hosted profile runs as the `music-stats-web` Worker. It uses a D1 database
for listening history and a KV namespace for profile snapshots.

## Create the Cloudflare resources

Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) with an
account that owns the `rising.sh` zone and can create Workers resources.

From the repository root, enter `apps/web/`, install the pinned tools, then log
Wrangler in:

```sh
cd apps/web
mise install
npx wrangler login
```

Create the D1 database and copy the returned database ID:

```sh
cd apps/web
npx wrangler d1 create music-stats
```

Create the KV namespace and copy the returned namespace ID:

```sh
npx wrangler kv namespace create CACHE
```

Replace `REPLACE_WITH_D1_DATABASE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID` in
[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc) with those IDs. Keep the
bindings named `DB` and `CACHE`.

## Apply the schema

From `apps/web/`, apply the migration to the remote database:

```sh
npx wrangler d1 migrations apply music-stats --remote
```

The migration creates the complete schema used by the current and later web
milestones. Do not edit a deployed migration. Add a later migration when the
schema changes.

## Configure the deploy secret

In the repository's GitHub settings, open **Secrets and variables → Actions**
and add these repository secrets:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Workers Scripts edit,
  Workers Routes edit, D1 edit and KV edit permissions for this account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID that owns the Worker.

The deploy workflow reads these names. It does not store their values in the
repository.

## Configure GitHub sign-in

Sign-in uses the shared GitHub OAuth App `rising.sh`, owned by the `risinghq`
organization. Every rising.sh product uses it, each with its own exact redirect
URI. Wildcard matching is off. Do not register a new OAuth App.

The Worker sends `redirect_uri` as the origin of the request plus
`/auth/github/callback` ([`apps/web/src/auth.ts`](../apps/web/src/auth.ts)). It
is `https://music.rising.sh/auth/github/callback` when deployed and
`http://localhost:8787/auth/github/callback` under `wrangler dev`.

Open the app as an organization owner: **risinghq → Settings → Developer
settings → OAuth Apps → rising.sh**. Under **Authorization callback URLs**, add
one entry for each of these that the app does not list yet:

- `https://music.rising.sh/auth/github/callback`
- `http://localhost/auth/github/callback`

A fork serving another domain adds `https://<domain>/auth/github/callback`
instead. GitHub ignores the port of a loopback redirect URI, so the one
`http://localhost/...` entry covers `wrangler dev` on any port, including 8787.

Generate a client secret for this Worker. On the app's page, under **Client
secrets**, choose **Generate a new client secret**, and copy the value at once:
GitHub shows it once. Each Worker has its own secret, so revoking one product's
secret leaves the others signed in. Copy the app's **Client ID** from the same
page. Store both as Worker secrets, from `apps/web/`:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Local development uses its own client secret, generated the same way, and the
same client id. Put them in `apps/web/.dev.vars`, and do not commit that file:

```sh
GITHUB_CLIENT_ID=the-client-id
GITHUB_CLIENT_SECRET=the-local-client-secret
```

## Attach the custom domain

The `routes` entry in `apps/web/wrangler.jsonc` attaches `music.rising.sh` as a
Worker custom domain. Ensure `rising.sh` is active in the same Cloudflare
account, then deploy from the repository root:

```sh
npm --prefix apps/web ci
npm --prefix apps/web run deploy
```

Cloudflare creates the DNS record and certificate for the custom domain. Check
the result in **Workers & Pages → music-stats-web → Settings → Domains &
Routes**.

## Create the Spotify app

The pulled source is one shared Spotify app owned by the operator. In the
[Spotify developer dashboard](https://developer.spotify.com/dashboard) create an
app, select **Web API**, and add these redirect URIs:

- `https://music.rising.sh/auth/spotify/callback`
- `http://127.0.0.1:8787/auth/spotify/callback`

Spotify rejects `localhost` in a redirect URI; the local one must be a loopback
literal such as `127.0.0.1`
([redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)).

Under **User Management**, add the Spotify email of every user who may connect.
Development mode allows 5 users, and the app owner must have Spotify Premium.

Copy the app's client ID and client secret and store them as Worker secrets,
from `apps/web/`:

```sh
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
```

The refresh tokens live in `sources.secret`, AES-GCM encrypted. Generate a
32-byte key, print it as base64, and store it too:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put SPOTIFY_ENCRYPTION_KEY
```

For local development put the same values in `apps/web/.dev.vars`, and do not
commit that file:

```sh
SPOTIFY_CLIENT_ID=the-client-id
SPOTIFY_CLIENT_SECRET=the-local-client-secret
SPOTIFY_ENCRYPTION_KEY=the-base64-key
```

Users sign in with GitHub and connect Spotify on the settings page. The cron
trigger pulls the source on the next minute.

## Add a YouTube Music upload token

An upload token lets the user's GitHub Action post plays to
`POST /api/v1/upload`. The database keeps only the token's SHA-256 hash, so
create the token after the user has a `ytmusic` source.

Add the source if the user does not have one yet:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO sources (user_id, kind) VALUES ((SELECT id FROM users WHERE name = 'alice'), 'ytmusic');"
```

Run the token script from `apps/web/` with the source's id. It prints the token
once and the SQL that stores its hash:

```sh
node scripts/make-token.mjs 1
```

Paste the printed `INSERT` into a remote execute:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (1, X'...', '....', unixepoch());"
```

Store the printed token as `UPLOAD_TOKEN` in the user repository's Actions
secrets. The token is not stored anywhere else; if it is lost, run the script
again and revoke the old row by setting `revoked_at`.

## Phone scrobbler

Users issue a scrobbler token on the settings page under **Phone scrobbler** and
paste it into a ListenBrainz-compatible app such as Pano Scrobbler, with
`https://music.rising.sh` as the server. The source needs no Worker secret or
OAuth app: the token lives hashed in the `tokens` table against the user's
`listenbrainz` source.
