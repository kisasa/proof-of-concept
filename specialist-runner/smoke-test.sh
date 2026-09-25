#!/usr/bin/env bash
#
# Verifies the built specialist image against the claims README.md makes about
# it: which toolchains are present, at which versions, as which user, and how
# each ecosystem's locked restore behaves.
#
# An operator script, run locally, deliberately not wired into CI — it needs a
# Docker daemon and a few minutes, and the thing it guards changes only when
# someone edits the Dockerfile. Run it then.
#
#   ./smoke-test.sh                       # build, then verify
#   ./smoke-test.sh --image <tag>         # verify an image already built
#
# Exits 0 when every check passes, 1 naming each that did not.

set -uo pipefail

IMAGE="specialist-runner:smoke"
BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; BUILD=0; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }

# Runs a command inside the image as the image's own runtime user; never
# `--user root`, because the point of most of these checks is that the
# unprivileged user can reach the toolchain.
in_image() { docker run --rm "$IMAGE" sh -c "$1" 2>&1; }

# $1 label, $2 command, $3 expected substring of the output.
expect_contains() {
  local out; out="$(in_image "$2")"
  case "$out" in
    *"$3"*) pass "$1 ($3)" ;;
    *) fail "$1 — expected to contain '$3', got: $(printf '%s' "$out" | head -1)" ;;
  esac
}

# $1 label, $2 command, $3 "succeeds"|"fails".
expect_status() {
  local expected="$3"
  if in_image "$2 >/dev/null 2>&1"; then
    [ "$expected" = "succeeds" ] && pass "$1 (succeeds)" || fail "$1 — succeeded, expected to fail"
  else
    [ "$expected" = "fails" ] && pass "$1 (fails)" || fail "$1 — failed, expected to succeed"
  fi
}

if [ "$BUILD" -eq 1 ]; then
  echo "Building $IMAGE ..."
  docker build -f "$HERE/Dockerfile" -t "$IMAGE" "$HERE" >/dev/null || {
    echo "build failed" >&2; exit 1; }
fi

echo
echo "Runtime user and toolchains"
expect_contains "runs as the unprivileged user" 'id -un' 'node'
expect_contains "Node 22"                       'node --version' 'v22.'
expect_contains "Python 3.11"                   'python3 --version' 'Python 3.11.'
expect_contains "Poetry 2.4.3"                  'poetry --version' '2.4.3'
expect_contains ".NET SDK 10"                   'dotnet --version' '10.'
expect_contains "git present"                   'git --version' 'git version'
expect_contains "curl present"                  'curl --version' 'curl '

echo
echo "Docker stays absent (Fargate offers no privileged mode; see README)"
expect_status "docker is not installed" 'command -v docker' 'fails'

echo
echo "Locked restore — npm"
expect_status "npm ci without a lockfile" \
  'mkdir -p /tmp/n && cd /tmp/n && printf "{\"name\":\"n\",\"version\":\"1.0.0\"}" > package.json && npm ci' 'fails'

echo
echo "Locked restore — Poetry"
expect_status "poetry check --lock without a lock file" \
  'mkdir -p /tmp/p && cd /tmp/p && printf "[project]\nname = \"p\"\nversion = \"0.1.0\"\nrequires-python = \">=3.11\"\ndependencies = []\n\n[build-system]\nrequires = [\"poetry-core>=2.0.0,<3.0.0\"]\nbuild-backend = \"poetry.core.masonry.api\"\n" > pyproject.toml && poetry check --lock' 'fails'

echo
echo "Locked restore — .NET (the asymmetric one; see README)"
# Documented rather than desired: with no packages.lock.json, --locked-mode
# restores normally and reports success. The check asserts that it still does,
# so that the day the SDK starts failing instead, this script says so and the
# README and the specialist's definition can both drop the caveat.
expect_status "dotnet --locked-mode without a lock file still passes" \
  'cd /tmp && dotnet new classlib -o d1 >/dev/null && cd d1 && dotnet restore --locked-mode' 'succeeds'
expect_status "dotnet --locked-mode catches a drifted lock file" \
  'cd /tmp && dotnet new classlib -o d2 >/dev/null && cd d2 && dotnet restore --use-lock-file >/dev/null && dotnet add package Newtonsoft.Json --version 13.0.3 --no-restore >/dev/null && dotnet restore --locked-mode' 'fails'

echo
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed."
else
  echo "Some checks failed (see FAIL lines above)."
fi
exit "$FAILED"
