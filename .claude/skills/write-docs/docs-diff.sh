#!/usr/bin/env bash
# docs-diff.sh — surface what changed since the last documentation sync.
# Used by the write-docs skill to decide what needs updating in docs/SYSTEMS.md,
# docs/FILES.md, and what to write into docs/CHANGELOG.md.
#
# Usage:
#   .claude/skills/write-docs/docs-diff.sh
#
# Output is plain text meant to be read by an agent, not parsed by machine.
set -e
cd "$(git rev-parse --show-toplevel)"

MARKER=".claude/skills/write-docs/.last-sync"

echo "=== Working tree status (uncommitted changes) ==="
git status --porcelain=v1 -- . ":(exclude).claude/skills/write-docs/.last-sync" || true
echo

if [ -f "$MARKER" ]; then
  LAST="$(cat "$MARKER")"
  if git cat-file -e "${LAST}^{commit}" 2>/dev/null; then
    echo "=== Committed changes since last doc sync ($LAST) ==="
    git log --oneline "$LAST"..HEAD -- . ":(exclude)docs/" ":(exclude).claude/skills/write-docs/.last-sync"
    echo
    echo "=== Files changed since last doc sync ==="
    git diff --name-status "$LAST"..HEAD -- . ":(exclude)docs/" ":(exclude).claude/skills/write-docs/.last-sync"
  else
    echo "!! Marker commit $LAST no longer exists in history (rebase/squash?)."
    echo "!! Treat this as a full-repo re-scan — ignore the marker for this run."
  fi
else
  echo "=== No sync marker found — this is the first run ==="
  echo "Treat as a full-repo scan. All tracked files:"
  git ls-files -- . ":(exclude)docs/" ":(exclude).flutter_sdk" ":(exclude)node_modules"
fi
