# GitHub Actions

The template repository contains a workflow,
[`gist.yml`](../.github/workflows/gist.yml), that runs `music-stats` every day
and updates your Gist. You do not need a machine of your own.

## Before you start

- A public Gist created at <https://gist.github.com>. Copy its ID from the URL.
- A
  [personal access token](https://github.com/settings/personal-access-tokens/new)
  with the Gists permission.
- Credentials for at least one provider. See [Providers](providers.md).

## Set up

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

## Schedule

The workflow runs daily at 00:00 UTC. Change the `cron` expression in
[`gist.yml`](../.github/workflows/gist.yml) to run at other times.

## Settings

To change `DAYS` or `TOP_N`, add them as repository variables, not secrets, at
`https://github.com/<username>/<repository>/settings/variables/actions`. An
unset or blank variable means the default. See [Configuration](configuration.md)
for their values.

The workflow passes `GIST_ID`, `GH_TOKEN`, `LASTFM_API_KEY`, `LASTFM_USERNAME`,
`YOUTUBE_COOKIE`, `DAYS` and `TOP_N` to the program, and nothing else.
