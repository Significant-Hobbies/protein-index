#!/bin/zsh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
data_root="${PROTEIN_INDEX_DATA_ROOT:?Set PROTEIN_INDEX_DATA_ROOT to a local writable directory.}"
lock_directory="$data_root/.macro-refresh.lock"

mkdir -p "$data_root/logs"
if ! mkdir "$lock_directory" 2>/dev/null; then
  print -u2 "Protein Index macro refresh is already running."
  exit 0
fi
trap 'rmdir "$lock_directory"' EXIT

cd "$repo_root"
pnpm data:macro-refresh --root "$data_root" --phase all --label-limit "${PROTEIN_INDEX_LABEL_LIMIT:-100}" --run-labels
