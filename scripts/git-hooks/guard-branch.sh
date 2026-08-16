#!/bin/sh
#
# PreToolUse guard: refuse edits and commits made while `main` is checked out.
#
# Wired up from .claude/settings.json, which passes the tool-call JSON on
# stdin. We look at where the change would actually land:
#
#   Edit / Write  -> the branch of the checkout containing the target file,
#                    so a worktree is judged by its own HEAD, not the cwd's
#   Bash          -> only commands that mention `git commit`, judged by cwd
#
# Anything not on `main` passes silently. See documentation/BRANCH-SAFETY.md.
#
# This is the fast, specific check; scripts/git-hooks/pre-commit is the
# catch-all backstop that also covers commits made outside Claude Code.
#
# Escape hatch, for a session that genuinely should touch main:
#
#     CLAUDE_ALLOW_MAIN_EDITS=1 claude

set -u

if [ -n "${CLAUDE_ALLOW_MAIN_EDITS:-}" ]; then
    exit 0
fi

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty')

case "$tool" in
    Edit | Write | NotebookEdit)
        target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
        [ -n "$target" ] || exit 0

        # The file may not exist yet; walk up to the nearest directory that does.
        dir=$(dirname "$target")
        while [ ! -d "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "." ]; do
            dir=$(dirname "$dir")
        done
        [ -d "$dir" ] || exit 0
        ;;
    Bash)
        command=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
        case "$command" in
            *"git commit"*) ;;
            *) exit 0 ;;
        esac
        dir=$(pwd)
        ;;
    *)
        exit 0
        ;;
esac

branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
[ "$branch" = "main" ] || exit 0

reason='This checkout is on `main`, and work is not allowed to land there.

Before continuing, either:
  - branch in place:   git switch -c <branch-name>
  - or give this task its own checkout, so concurrent sessions cannot
    collide:           scripts/new-worktree.sh <branch-name>

Then retry. (See documentation/BRANCH-SAFETY.md.)'

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
