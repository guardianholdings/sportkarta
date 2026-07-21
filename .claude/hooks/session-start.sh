#!/usr/bin/env bash
# SessionStart hook: print the current git branch and the first unchecked
# "- [ ]" ROADMAP item under each stage heading (docs/ROADMAP.md §1).
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

branch=$(git branch --show-current 2>/dev/null)
echo "git branch: ${branch:-detached/none}"

if [ -f docs/ROADMAP.md ]; then
  if grep -Eq '^[[:space:]]*- \[ \]' docs/ROADMAP.md; then
    echo "Next unchecked ROADMAP items (first per stage):"
    awk '
      /^## / { header = $0; shown = 0 }
      /^[[:space:]]*- \[ \]/ && !shown { print "  " header " -> " $0; shown = 1 }
    ' docs/ROADMAP.md
  else
    echo "ROADMAP: no unchecked checkbox items yet (stages gain - [ ] items as work is broken down)"
  fi
fi

exit 0
