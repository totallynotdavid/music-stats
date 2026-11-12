# GitHub Actions

Two workflows in the template repository run `music-stats` on a schedule.
[`gist.yml`](../.github/workflows/gist.yml) runs it every day and updates your
Gist. [`upload.yml`](../.github/workflows/upload.yml) runs it every three hours
and posts your YouTube Music plays to the hosted service. You do not need a
machine of your own. The Gist stays the option that needs no account anywhere.

## Before you start

- A public Gist created at <https://gist.github.com>. Copy its ID from the URL.
- A
  [personal access token](https://github.com/settings/personal-access-tokens/new)
  with the Gists permission.
- Credentials for at least one provider. See [Providers](providers.md).

## Set up the Gist

1. Create a repository from the
   [template](https://github.com/new?template_name=music-stats&template_owner=totallynotdavid).
2. Open the repository's Actions secrets settings and add:

   - `GIST_ID`
   - `GH_TOKEN`
   - `LASTFM_API_KEY` and `LASTFM_USERNAME`, or `YOUTUBE_COOKIE`, or both

3. Run the workflow once from the Actions tab: select **update gist**, then
   **Run workflow**.

The workflow builds `music-stats` from the repository's own source, so the first
run compiles the program, which takes a few minutes. Every daily run compiles it
again.

## Upload to the service

The hosted service keeps every play the YouTube Music history page holds and
serves a public profile, a JSON endpoint and an SVG card for your README. To
send it your plays, on top of the Gist or instead of it:

1. Create an upload token on the service's settings page. The page shows the
   token once, when you create it.
2. Open the repository's Actions secrets settings and add `UPLOAD_TOKEN` and
   `YOUTUBE_COOKIE`.
3. Run the workflow once from the Actions tab: select **upload plays**, then
   **Run workflow**.

The workflow does not compile `music-stats`. It downloads the binary that
[`release.yml`](../.github/workflows/release.yml) attaches to each release of
the upstream repository, with `gh release download`.

It runs every three hours. The history page holds about 200 plays, ten hours of
continuous listening, so a three-hour gap leaves a threefold margin before a
play falls off the page.

While `UPLOAD_TOKEN` is unset, the workflow skips the upload job, so the
template repository itself and a repository that only updates a Gist see no
failing run.

`UPLOAD_URL` and `MUSIC_STATS_TZ` are optional repository variables.
`UPLOAD_URL` points the upload at another service address
(`https://music.rising.sh` when unset). `MUSIC_STATS_TZ` names the time zone
that "Today" and "Yesterday" on the history page mean. See
[Configuration](configuration.md).

## Schedule

The Gist workflow runs daily at 00:00 UTC and the upload workflow every three
hours. Change the `cron` expression in
[`gist.yml`](../.github/workflows/gist.yml) or
[`upload.yml`](../.github/workflows/upload.yml) to run at other times.

GitHub disables a scheduled workflow in a repository with no activity for 60
days. Both workflows carry a `keepalive` job that runs on each scheduled run and
enables the workflow again through the API, which resets that count. It needs no
secret and makes no commit.

## Failed runs

A run fails when a provider fails, even if the other provider updated the Gist.
An upload run also fails when the service refuses the plays, for example on a
revoked `UPLOAD_TOKEN`. GitHub emails you about a failed scheduled run, so an
expired YouTube cookie shows up the next day. Replace the `YOUTUBE_COOKIE`
secret as [Providers](providers.md#keep-the-cookie-working) describes.

## Settings

To change `DAYS` or `TOP_N`, add them as repository variables, not secrets, at
`https://github.com/<username>/<repository>/settings/variables/actions`. An
unset or blank variable means the default. See [Configuration](configuration.md)
for their values.

The Gist workflow passes `GIST_ID`, `GH_TOKEN`, `LASTFM_API_KEY`,
`LASTFM_USERNAME`, `YOUTUBE_COOKIE`, `DAYS` and `TOP_N` to the program, and
nothing else. The upload workflow passes `YOUTUBE_COOKIE`, `UPLOAD_TOKEN`,
`UPLOAD_URL` and `MUSIC_STATS_TZ`, and nothing else.
