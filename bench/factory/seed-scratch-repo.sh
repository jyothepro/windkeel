#!/bin/sh
# Builds the factory benchmark's scratch repository from bench/factory/scratch-repo/ as one
# commit with a fixed author, committer and date, so its SHA is the same on every machine — the
# `base_ref` the real-repo tasks name. Prints that SHA.
#
#   bench/factory/seed-scratch-repo.sh <empty-dir>
#   git -C <empty-dir> push https://github.com/<owner>/orqon-bench-scratch.git HEAD:refs/heads/main
#
# The SHA it prints must equal the `base_ref` in bench/factory/tasks/repo-*/task.json; a test
# (test/bench-factory.test.js) holds the two together.
set -eu
target=${1:?usage: seed-scratch-repo.sh <empty-dir>}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$target"
if [ -n "$(ls -A "$target")" ]; then
  echo "seed-scratch-repo: $target is not empty" >&2
  exit 2
fi
cp -R "$here/scratch-repo/." "$target/"
cd "$target"
export GIT_AUTHOR_NAME="Orqon bench" GIT_AUTHOR_EMAIL="bench@orqon.invalid"
export GIT_COMMITTER_NAME="Orqon bench" GIT_COMMITTER_EMAIL="bench@orqon.invalid"
export GIT_AUTHOR_DATE="2026-10-21T00:00:00Z" GIT_COMMITTER_DATE="2026-10-21T00:00:00Z"
git init -q -b main
git config core.autocrlf false
# Modes are normalised so a checkout that lost the executable bit cannot change the tree.
find . -path ./.git -prune -o -type f -exec chmod 644 {} +
git add -A
git -c commit.gpgsign=false commit -q -m "Seed the factory benchmark's scratch repository"
git rev-parse HEAD
