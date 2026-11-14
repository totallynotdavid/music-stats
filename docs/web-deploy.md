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

## Add a ListenBrainz user

Users sign in with GitHub and connect a source on the settings page. To add a
public user by hand instead, run one command against the remote D1 database.
`github_id` is an operator-supplied numeric identifier, `name` is the public URL
name, and `created_at` is the current Unix timestamp. Run it from `apps/web/`:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO users (github_id, name, created_at) VALUES (123456, 'alice', unixepoch());
   INSERT INTO sources (user_id, kind, account, next_pull_at)
   VALUES ((SELECT id FROM users WHERE name = 'alice'), 'listenbrainz', 'alice', unixepoch());"
```

The source account is the public ListenBrainz username. The cron trigger pulls
it on the next minute. Verify the public page and JSON response:

```sh
curl -i 'https://music.rising.sh/u/alice'
curl -i 'https://music.rising.sh/u/alice.json?period=week'
```

## Add a Last.fm source

Last.fm data is behind a launch gate: the cron does not pull it, and the profile
shows only the user's other sources, until `LASTFM_APPROVAL` in
[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc) is set. It stays empty
until Last.fm approves the service in writing. Do not set it without that
approval.

Create a Last.fm API account at
[https://www.last.fm/api/account/create](https://www.last.fm/api/account/create)
and store its API key as a Worker secret, from `apps/web/`:

```sh
npx wrangler secret put LASTFM_API_KEY
```

Add the source against the remote D1 database:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO sources (user_id, kind, account, next_pull_at)
   VALUES ((SELECT id FROM users WHERE name = 'alice'), 'lastfm', 'alice-fm', unixepoch());"
```

The source account is the public Last.fm username. After approval is set and
deployed, the cron pulls the source and the profile names Last.fm and carries
the AudioScrobbler credit.

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
