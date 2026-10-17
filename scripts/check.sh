#!/usr/bin/env bash
# Every check, from the repo root, stopping at the first that fails:
# the state-ref rule (which `claude plugin validate` does not catch), then
# the manifest and the tests.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; "$@"; }

step node scripts/check-state-refs.mjs
step claude plugin validate .
step claude plugin test .
printf '\nall checks passed\n'
