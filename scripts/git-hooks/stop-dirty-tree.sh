#!/bin/sh
#
# Stop hook: report work left uncommitted in the primary checkout at the end
# of a turn.
#
# An uncommitted working tree is the state no guard can protect. The other
# hooks here refuse and report the operations that strand it, but none of them
# can put it back — the only real defence is for it not to be sitting there
# when somebody else's `git checkout` or `git add -A` arrives. This closes the
# gap the cheap way: a reminder, every turn, for as long as it is exposed.
#
# It warns rather than committing anything. Auto-committing work in progress
# was the other candidate (documentation/MISCELLANEOUS-TASKS.md item 1), and
# it buys a smaller window at the cost of a history that has to be squashed
# before every PR. A warning has no blast radius at all.
#
# The primary checkout only, and deliberately so. That is the checkout
# sessions share, and per CLAUDE.md it is for reading and for `main` — so
# there should rarely be anything uncommitted in it, and a warning about one
# is worth reading. A worktree belongs to one task; warning about its
# uncommitted tree would fire on every turn of normal work until it was
# ignored, which would cost more than it is worth.
#
# Wired up from .claude/settings.json.
#
# Three things about the hook contract are taken from Claude Code's own
# documentation and have not been confirmed against a running session: that
# the payload arrives on stdin, that `systemMessage` is what surfaces text to
# the user, and that a reply carrying no `decision` lets the turn end. The
# first two decide whether any of this is seen at all, so if the warning never
# appears they are the place to look before the logic below. The third is
# belt-and-braces already — exiting 0 says the same thing a second way.
#
# See documentation/BRANCH-SAFETY.md.

set -u

cat >/dev/null 2>&1 || true      # drain the payload; nothing here needs it

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ "$git_dir" = "$common_dir" ] || exit 0

dirty=$(git status --porcelain 2>/dev/null) || exit 0
[ -n "$dirty" ] || exit 0

count=$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || branch='a detached HEAD'
[ "$count" = "1" ] && noun='file' || noun='files'

message="⚠ $count uncommitted $noun in the primary checkout, on '$branch'

$(printf '%s' "$dirty" | head -n 12)

This is the checkout other sessions share, so anything uncommitted here
can be carried off by somebody else's branch switch or swept into
somebody else's commit. Commit it, or move the work somewhere of its own:

    scripts/new-worktree.sh <branch-name>"

jq -n --arg message "$message" '{ systemMessage: $message }'
exit 0
