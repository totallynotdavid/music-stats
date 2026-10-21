# Releasing

[`release.yml`](../.github/workflows/release.yml) runs on a tag that matches
`v*.*.*`, on every pull request, and on a manual run. Every run does the same
work. Only a tag uploads anything, so a release that would fail fails on the
pull request. The workflow:

1. Runs `scripts/preflight.sh`, in `totallynotdavid/music-stats` only. It fails
   when a job names an environment the repository lacks. It uses the job's
   `GITHUB_TOKEN` with `actions: read` and `deployments: read`.
2. Runs `scripts/check-release.sh`. It fails when the first line of
   `.github/release-notes.md` is not `music-stats <version> is out.` for the
   version in `Cargo.toml`. On a tag it also fails when the tag is not `v` plus
   that version. Nothing else runs until it passes.
3. Packages the crate and builds it from the package with `mise run package`.
4. Builds the release binary with `mise run build` on Linux and uploads the
   binary as the workflow artifact `music-stats-linux-x86_64`.
5. On a tag only, creates a GitHub release for the tag, with the text of
   `.github/release-notes.md`, then GitHub's generated change list, and the
   binary attached.
6. On a tag only, publishes the crate to
   [crates.io](https://crates.io/crates/music-stats) with Trusted Publishing
   (OIDC). This job runs in the `release` environment.

`mise run publish` publishes the version in `Cargo.toml`. Before you tag, set
the version in `Cargo.toml`, run `cargo build` to update `Cargo.lock`, and
rewrite `.github/release-notes.md` for the new version. Check them with
`scripts/check-release.sh v<version>`, and open a pull request to see the dry
run pass.

The preflight and publish jobs run only in `totallynotdavid/music-stats`. A tag
in a repository made from the template builds a release and does not publish.

## Set up the release environment

1. In the repository, open Settings, then Environments, then New environment.
2. Name it `release`.
3. Under Deployment branches and tags, choose Selected branches and tags, and
   add the tag rule `v*`.
4. Optionally add yourself under Required reviewers. A tag then waits for your
   approval before it publishes.

## Set up Trusted Publishing

crates.io accepts an OIDC login only for a crate that already exists. Publish
the first version with `mise run publish`, with an API token in
`CARGO_REGISTRY_TOKEN`. Then open the crate's Settings on crates.io, and add a
trusted publisher with these values:

| Field       | Value             |
| ----------- | ----------------- |
| Owner       | `totallynotdavid` |
| Repository  | `music-stats`     |
| Workflow    | `release.yml`     |
| Environment | `release`         |

The workflow publishes every later version.
