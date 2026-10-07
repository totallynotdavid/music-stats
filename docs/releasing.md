# Releasing

Pushing a tag that matches `v*.*.*` runs
[`release.yml`](../.github/workflows/release.yml). The workflow:

1. Builds `cargo build --release` on Linux and uploads the binary as
   `music-stats-linux-x86_64`.
2. Creates a GitHub release for the tag, with generated release notes and the
   binary attached.
3. Publishes the crate to [crates.io](https://crates.io/crates/music-stats) with
   Trusted Publishing (OIDC). This job runs in the `release` environment.

`cargo publish` publishes the version in `Cargo.toml`. Set the version there
before you tag.

The publish job runs only in `totallynotdavid/music-stats`. A tag in a
repository made from the template builds a release and does not publish.

## Set up Trusted Publishing

crates.io accepts an OIDC login only for a crate that already exists. Publish
the first version with an API token, either with `cargo publish --token` or with
`CARGO_REGISTRY_TOKEN` set. Then add this repository, the workflow `release.yml`
and the environment `release` as a trusted publisher in the crate's settings on
crates.io. The workflow publishes every later version.
