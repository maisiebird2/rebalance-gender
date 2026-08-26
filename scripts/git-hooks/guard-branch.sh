#!/bin/sh
#
# PreToolUse guard against the two ways work lands somewhere it shouldn't.
#
# Wired up from .claude/settings.json, which passes the tool-call JSON on
# stdin. There are two independent checks:
#
#   1. Work on `main`. Edit / Write / NotebookEdit, and any Bash `git commit`,
#      are refused while `main` is checked out. We look at where the change
#      would actually land:
#
#        Edit / Write  -> the branch of the checkout containing the target
#                         file, so a worktree is judged by its own HEAD, not
#                         the cwd's
#        Bash          -> only commands that mention `git commit`, judged by
#                         cwd
#
#   2. HEAD surgery over uncommitted work in the primary checkout. `git
#      checkout`, `git switch`, `git reset` and `git stash` are refused there
#      while the working tree is dirty, because the primary checkout is the
#      one several sessions share and those changes may not be ours to move.
#      Worktrees are exempt: a worktree belongs to one task, so its HEAD is
#      nobody else's to lose.
#
# Anything else passes silently. See documentation/BRANCH-SAFETY.md.
#
# Both checks judge a Bash command by the session's working directory. A
# command that reaches into another checkout with `git -C <dir>` is therefore
# invisible to them — that case is covered by guidance, not by this hook.
#
# This is the fast, specific check. scripts/git-hooks/pre-commit is the
# catch-all backstop for commits made outside Claude Code, and
# scripts/git-hooks/post-checkout warns after the fact about the switches no
# hook can block.
#
# Escape hatches, for a session that genuinely should do one of these:
#
#     CLAUDE_ALLOW_MAIN_EDITS=1 claude
#     CLAUDE_ALLOW_DIRTY_SWITCH=1 claude

set -u

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty')

# Emit a PreToolUse denial carrying $1 as the explanation, then stop.
deny() {
    jq -n --arg reason "$1" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
}

# True when $1 would move HEAD or shelve the working tree.
#
# Two families are deliberately let through:
#
#   - path-limited restores (`git checkout -- src/x.ts`, `git checkout <sha> --
#     src/x.ts`). They leave HEAD alone and name their targets explicitly, and
#     they are the documented recovery route in
#     documentation/MISCELLANEOUS-TASKS.md.
#   - branch creation in place (`git switch -c`, `git checkout -b`). That
#     carries the working tree onto a branch of its own, which is the fix for
#     this situation rather than an instance of it — and it is what the `main`
#     denial below tells you to run.
#
moves_head() {
    case "$1" in
        *"git stash list"* | *"git stash show"*)
            return 1 ;;                                  # read-only
        *"git checkout"*" -- "* | *"git switch"*" -- "*)
            return 1 ;;                                  # path-limited restore
        *"git switch"*" -c "* | *"git switch"*" --create "*)
            return 1 ;;                                  # new branch in place
        *"git checkout"*" -b "*)
            return 1 ;;                                  # new branch in place
        *"git checkout"* | *"git switch"* | *"git reset"* | *"git stash"*)
            return 0 ;;
    esac
    return 1
}

# True when $1 is the repository's primary checkout rather than a worktree.
# The two directories coincide only in the primary checkout, and both come
# back from the same invocation, so they are directly comparable.
is_primary_checkout() {
    git_dir=$(git -C "$1" rev-parse --git-dir 2>/dev/null) || return 1
    common_dir=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 1
    [ "$git_dir" = "$common_dir" ]
}

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
        dir=$(pwd)

        # Check 2, before the `main` test: this one fires on any branch.
        if [ -z "${CLAUDE_ALLOW_DIRTY_SWITCH:-}" ] && moves_head "$command" && is_primary_checkout "$dir"; then
            dirty=$(git -C "$dir" status --porcelain 2>/dev/null)
            if [ -n "$dirty" ]; then
                deny "This is the primary checkout and its working tree is dirty, so
moving \`HEAD\` here can strand work that belongs to another session:

$(printf '%s' "$dirty" | head -n 12)

\`HEAD\` belongs to the directory, not to this conversation. A switch
carries or shelves whatever is uncommitted, and whoever wrote it carries
on believing it is still in place.

Instead:
  - work somewhere of your own:  scripts/new-worktree.sh <branch-name>
  - or, if the changes above are yours, take them with you: \`git switch -c
    <branch-name>\` is allowed, and lands them on a branch of their own.

To override this once you are sure the tree is yours:

    CLAUDE_ALLOW_DIRTY_SWITCH=1 claude

(See documentation/BRANCH-SAFETY.md.)"
            fi
        fi

        # Check 1 covers only commits.
        case "$command" in
            *"git commit"*) ;;
            *) exit 0 ;;
        esac
        ;;
    *)
        exit 0
        ;;
esac

[ -z "${CLAUDE_ALLOW_MAIN_EDITS:-}" ] || exit 0

branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
[ "$branch" = "main" ] || exit 0

deny 'This checkout is on `main`, and work is not allowed to land there.

Before continuing, either:
  - branch in place:   git switch -c <branch-name>
  - or give this task its own checkout, so concurrent sessions cannot
    collide:           scripts/new-worktree.sh <branch-name>

Then retry. (See documentation/BRANCH-SAFETY.md.)'
