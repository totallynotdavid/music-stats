# Releasing

Pushing a tag that matches `v*.*.*` runs
[`release.yml`](../.github/workflows/release.yml). The workflow:

1. Runs `scripts/check-release.sh` on the tag. It fails when the tag is not `v`
   plus the version in `Cargo.toml`, or when the first line of
   `.github/release-notes.md` is not `music-stats <version> is out.`. Nothing
   else runs until it passes.
2. Builds the release binary with `mise run build` on Linux and uploads the
   binary as `music-stats-linux-x86_64`.
3. Creates a GitHub release for the tag, with the text of
   `.github/release-notes.md`, then GitHub's generated change list, and the
   binary attached.
4. Publishes the crate to [crates.io](https://crates.io/crates/music-stats) with
   Trusted Publishing (OIDC). This job runs in the `release` environment.

`mise run publish` publishes the version in `Cargo.toml`. Before you tag, set
the version in `Cargo.toml`, run `cargo build` to update `Cargo.lock`, and
rewrite `.github/release-notes.md` for the new version. Check them with
`scripts/check-release.sh v<version>`.

The publish job runs only in `totallynotdavid/music-stats`. A tag in a
repository made from the template builds a release and does not publish.

## Set up Trusted Publishing

crates.io accepts an OIDC login only for a crate that already exists. Publish
the first version with `mise run publish`, with an API token in
`CARGO_REGISTRY_TOKEN`. Then add this repository, the workflow `release.yml` and
the environment `release` as a trusted publisher in the crate's settings on
crates.io. The workflow publishes every later version.
