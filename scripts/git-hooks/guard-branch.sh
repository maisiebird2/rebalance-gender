#!/bin/sh
#
# PreToolUse guard against the ways work lands somewhere it shouldn't.
#
# Wired up from .claude/settings.json, which passes the tool-call JSON on
# stdin. There are three independent checks:
#
#   1. Work on `main`. Edit / Write / NotebookEdit, and any Bash `git commit`,
#      are refused while `main` is checked out. We look at where the change
#      would actually land:
#
#        Edit / Write  -> the branch of the checkout containing the target
#                         file, so a worktree is judged by its own HEAD, not
#                         the cwd's
#        Bash          -> only commands that mention `git commit`, judged by
#                         the directory the command acts on
#
#   2. HEAD surgery over uncommitted work in the primary checkout. `git
#      checkout`, `git switch`, `git reset` and `git stash` are refused there
#      while the working tree is dirty, because the primary checkout is the
#      one several sessions share and those changes may not be ours to move.
#
#   3. Indiscriminate staging in the primary checkout. `git add -A`, `git add
#      .` and `git commit -a` stage by sweep rather than by name, and a sweep
#      cannot tell this session's new files from anybody else's. Refused there
#      while the working tree is dirty; name the paths instead.
#
# Worktrees are exempt from checks 2 and 3: a worktree belongs to one task, so
# its working tree is nobody else's to lose.
#
# Anything else passes silently. See documentation/BRANCH-SAFETY.md.
#
# A Bash command is judged by the directory it acts on — an explicit
# `git -C <dir>` where there is one, otherwise the session's working
# directory. A command that changes directory first (`cd elsewhere && git …`)
# is therefore still judged by where the session started; that case is covered
# by guidance, not by this hook.
#
# This is the fast, specific check. scripts/git-hooks/pre-commit is the
# catch-all backstop for commits made outside Claude Code,
# scripts/git-hooks/post-checkout warns after the fact about the switches no
# hook can block, and scripts/git-hooks/stop-dirty-tree.sh reports work left
# uncommitted at the end of a turn.
#
# Escape hatches, for a session that genuinely should do one of these:
#
#     CLAUDE_ALLOW_MAIN_EDITS=1 claude      # may touch main
#     CLAUDE_ALLOW_DIRTY_PRIMARY=1 claude   # may move or sweep a dirty primary

set -u

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty')

# CLAUDE_ALLOW_DIRTY_SWITCH is the name checks 2 and 3 shipped under when
# check 2 was the only one of them. Still honoured; prefer the new name.
allow_dirty=${CLAUDE_ALLOW_DIRTY_PRIMARY:-${CLAUDE_ALLOW_DIRTY_SWITCH:-}}

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

# True when $1 stages by sweep rather than by name. `git add -u` and `git
# commit <paths>` are not here: they are limited to files already tracked or
# already named, which is the behaviour we are asking for.
stages_by_sweep() {
    case "$1" in
        *"git add -A"* | *"git add --all"* | *"git add ."* | *"git add :/"*)
            return 0 ;;
        *"git commit -a"* | *"git commit --all"*)
            return 0 ;;
    esac
    return 1
}

# The directory a Bash command acts on: an explicit `git -C <dir>` where there
# is one, otherwise the session's working directory.
#
# Expects fold_leading_options() to have run, so that a `-C` belonging to git
# sits directly after it. Requiring `git` immediately before the `-C` is what
# keeps unrelated flags — `grep -C 3` above all — from being read as a
# directory.
#
# The argument is word-split on whitespace, so a path containing a space comes
# back truncated and fails the directory test below, falling back to the cwd.
# An option ordering this does not anticipate leaves the subcommand hidden and
# the command allowed. That is the same way the rest of this hook fails —
# open, on anything it cannot read — and it guards against accidents, not
# against someone trying to get around it.
target_dir() {
    explicit=$(printf '%s\n' "$1" | awk '
        { for (i = 2; i < NF; i++) if ($i == "-C" && $(i - 1) == "git") { print $(i + 1); exit } }
    ' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')

    case "$explicit" in
        "")  ;;
        /*)  [ -d "$explicit" ] && { printf '%s' "$explicit"; return; } ;;
        *)   [ -d "$(pwd)/$explicit" ] && { printf '%s/%s' "$(pwd)" "$explicit"; return; } ;;
    esac
    pwd
}

# git's global options sit between `git` and the subcommand, where they hide
# the subcommand from the substring tests above and hide `-C` from the
# directory lookup below. Both are folded away before anything is matched, in
# two stages, because the lookup needs `-C` still present but adjacent to
# `git`.
#
# First stage: everything except `-C`. Looping until the string stops changing
# handles a command carrying several — each pass strictly shortens it, so it
# terminates.
fold_leading_options() {
    folded=$1
    while :; do
        next=$(printf '%s' "$folded" | sed \
            -e 's/git[[:space:]]\{1,\}--no-pager[[:space:]]\{1,\}/git /' \
            -e 's/git[[:space:]]\{1,\}-c[[:space:]]\{1,\}[^[:space:]]\{1,\}[[:space:]]\{1,\}/git /')
        [ "$next" = "$folded" ] && break
        folded=$next
    done
    printf '%s' "$folded"
}

# Second stage: `git -C /x switch main` is matched as `git switch main`.
without_c_option() {
    printf '%s' "$1" | sed 's/git[[:space:]]\{1,\}-C[[:space:]]\{1,\}[^[:space:]]\{1,\}[[:space:]]\{1,\}/git /g'
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
        folded=$(fold_leading_options "$command")
        dir=$(target_dir "$folded")
        subcommands=$(without_c_option "$folded")

        # Checks 2 and 3, before the `main` test: these fire on any branch.
        if [ -z "$allow_dirty" ] && is_primary_checkout "$dir"; then
            dirty=$(git -C "$dir" status --porcelain 2>/dev/null)

            if [ -n "$dirty" ] && moves_head "$subcommands"; then
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

    CLAUDE_ALLOW_DIRTY_PRIMARY=1 claude

(See documentation/BRANCH-SAFETY.md.)"
            fi

            if [ -n "$dirty" ] && stages_by_sweep "$subcommands"; then
                deny "This is the primary checkout and its working tree is dirty, so a
staging sweep here can commit work that belongs to another session:

$(printf '%s' "$dirty" | head -n 12)

\`git add -A\` and \`git commit -a\` stage by sweep. A sweep cannot tell
this session's new files from anybody else's — they look identical — so
somebody else's work lands in your commit, on your branch, and vanishes
from where they left it.

Instead:
  - name what you changed:       git add path/one path/two
  - work somewhere of your own:  scripts/new-worktree.sh <branch-name>

To override this once you are sure the tree is yours:

    CLAUDE_ALLOW_DIRTY_PRIMARY=1 claude

(See documentation/BRANCH-SAFETY.md.)"
            fi
        fi

        # Check 1 covers only commits.
        case "$subcommands" in
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
