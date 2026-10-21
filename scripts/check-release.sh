#!/usr/bin/env bash
# Refuses a release tag that does not match the manifest or the release notes.
# Usage: scripts/check-release.sh vX.Y.Z
set -euo pipefail

tag="${1:?usage: check-release.sh vX.Y.Z}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

name="$(sed -n '/^\[package\]/,/^\[/{s/^name = "\(.*\)"$/\1/p;}' "$root/Cargo.toml")"
version="$(sed -n '/^\[package\]/,/^\[/{s/^version = "\(.*\)"$/\1/p;}' "$root/Cargo.toml")"

if [ "$tag" != "v$version" ]; then
  echo "error: tag $tag does not match Cargo.toml version $version" >&2
  exit 1
fi

expected="$name $version is out."
first="$(head -n 1 "$root/.github/release-notes.md")"
if [ "$first" != "$expected" ]; then
  echo "error: first line of .github/release-notes.md is '$first', expected '$expected'" >&2
  exit 1
fi

echo "ok: $tag matches Cargo.toml and .github/release-notes.md"
