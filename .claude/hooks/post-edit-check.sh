#!/usr/bin/env bash
# PostToolUse hook (matcher: Edit|Write): after any *.ts/*.tsx change, run
# pnpm typecheck + pnpm lint:fix. Exit 2 = blocking — stderr is fed back to
# Claude loudly (CLAUDE.md / docs/ROADMAP.md §1).
set -u

payload=$(cat)

file_path=$(printf '%s' "$payload" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(d);
    console.log((j.tool_input && j.tool_input.file_path) || "");
  } catch {
    console.log("");
  }
});
')

case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

if ! out=$(pnpm typecheck 2>&1); then
  {
    echo "HOOK FAILURE: pnpm typecheck failed after editing $file_path"
    printf '%s\n' "$out" | tail -40
  } >&2
  exit 2
fi

if ! out=$(pnpm lint:fix 2>&1); then
  {
    echo "HOOK FAILURE: pnpm lint:fix failed after editing $file_path (unfixable lint errors remain)"
    printf '%s\n' "$out" | tail -40
  } >&2
  exit 2
fi

exit 0
