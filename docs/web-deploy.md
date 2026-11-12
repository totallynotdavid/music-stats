# Web deployment

The hosted profile runs as the `music-stats-web` Worker. It uses a D1 database
for listening history and a KV namespace for profile snapshots.

## Create the Cloudflare resources

Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) with an
account that owns the `rising.sh` zone and can create Workers resources.

From the repository root, enter `web/`, install the pinned tools, then log
Wrangler in:

```sh
cd web
mise install
npx wrangler login
```

Create the D1 database and copy the returned database ID:

```sh
cd web
npx wrangler d1 create music-stats
```

Create the KV namespace and copy the returned namespace ID:

```sh
npx wrangler kv namespace create CACHE
```

Replace `REPLACE_WITH_D1_DATABASE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID` in
[`web/wrangler.jsonc`](../web/wrangler.jsonc) with those IDs. Keep the bindings
named `DB` and `CACHE`.

## Apply the schema

From `web/`, apply the migration to the remote database:

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

## Attach the custom domain

The `routes` entry in `web/wrangler.jsonc` attaches `music.rising.sh` as a
Worker custom domain. Ensure `rising.sh` is active in the same Cloudflare
account, then deploy from the repository root:

```sh
npm --prefix web ci
npm --prefix web run deploy
```

Cloudflare creates the DNS record and certificate for the custom domain. Check
the result in **Workers & Pages → music-stats-web → Settings → Domains &
Routes**.

## Add a ListenBrainz user

The first milestone has no sign-in flow. Add a public user and its source with
one command against the remote D1 database. `github_id` is an operator-supplied
numeric identifier, `name` is the public URL name, and `created_at` is the
current Unix timestamp. Run it from `web/`:

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

Last.fm configuration is not part of this milestone.

## Add a YouTube Music upload token

An upload token lets the user's GitHub Action post plays to
`POST /api/v1/upload`. The database keeps only the token's SHA-256 hash, so
create the token after the user has a `ytmusic` source.

Add the source if the user does not have one yet:

```sh
npx wrangler d1 execute music-stats --remote --command \
  "INSERT INTO sources (user_id, kind) VALUES ((SELECT id FROM users WHERE name = 'alice'), 'ytmusic');"
```

Run the token script from `web/` with the source's id. It prints the token once
and the SQL that stores its hash:

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
