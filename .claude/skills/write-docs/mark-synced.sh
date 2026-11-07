#!/usr/bin/env bash
# mark-synced.sh — record the current HEAD as the point docs are caught up to.
# Call this at the END of a write-docs run, after docs/SYSTEMS.md, docs/FILES.md,
# and docs/CHANGELOG.md have all been updated and (if applicable) committed.
#
# Usage:
#   .claude/skills/write-docs/mark-synced.sh
set -e
cd "$(git rev-parse --show-toplevel)"
git rev-parse HEAD > .claude/skills/write-docs/.last-sync
echo "Docs sync marker updated -> $(cat .claude/skills/write-docs/.last-sync)"
