#!/usr/bin/env bash
# Fails when a release workflow job names an environment the repository lacks.
# Such a job could not start on a tag.
# Needs yq and gh. GH_TOKEN must have read access to the repository's
# environments.
# Usage: scripts/preflight.sh owner/repo
set -euo pipefail

repo="${1:?usage: preflight.sh owner/repo}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

environments="$(yq -r '.jobs[].environment | select(. != null) | (select(tag == "!!str") // .name)' \
  "$root/.github/workflows/release.yml" | sort -u)"

failed=0
for environment in $environments; do
  if gh api "repos/$repo/environments/$environment" --silent; then
    echo "ok: environment $environment exists in $repo"
  else
    echo "error: environment $environment does not exist in $repo" >&2
    failed=1
  fi
done

exit "$failed"
