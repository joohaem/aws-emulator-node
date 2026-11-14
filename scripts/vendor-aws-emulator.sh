#!/usr/bin/env bash
# Prepare the aws/aws-emulator submodule (vendor/aws-emulator) for a native build: check it out
# at the pinned tag and apply patches/*.patch to its working tree. Idempotent: patches that are
# already applied are skipped, so `yarn build:native` runs this every time.
#
#   scripts/vendor-aws-emulator.sh                          # the tag the submodule is pinned to
#   AWS_EMULATOR_TAG=v1.0.400 scripts/vendor-aws-emulator.sh # bump: then commit vendor/aws-emulator
#
# Bumping drops the applied patches first (`git checkout -- .`), so patches that no longer apply
# to the new tag fail loudly here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/aws-emulator"

git -C "$ROOT" submodule update --init --depth 1 vendor/aws-emulator

if [ -n "${AWS_EMULATOR_TAG:-}" ]; then
  echo "==> checking out aws-emulator $AWS_EMULATOR_TAG"
  git -C "$DEST" checkout --quiet -- .
  git -C "$DEST" fetch --quiet --depth 1 origin tag "$AWS_EMULATOR_TAG"
  git -C "$DEST" -c advice.detachedHead=false checkout --quiet "$AWS_EMULATOR_TAG"
fi

for patch in "$ROOT"/patches/*.patch; do
  [ -e "$patch" ] || continue
  name="$(basename "$patch")"
  if git -C "$DEST" apply --reverse --check "$patch" 2>/dev/null; then
    echo "==> $name already applied"
  else
    echo "==> applying $name"
    git -C "$DEST" apply "$patch"
  fi
done

echo "==> aws-emulator $(git -C "$DEST" describe --tags --always) ($(git -C "$DEST" rev-parse HEAD))"
