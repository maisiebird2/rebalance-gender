#!/bin/sh
#
# Create a worktree for one task, wired up so it can build and run.
#
#     scripts/new-worktree.sh <branch-name>            # new branch off main
#     scripts/new-worktree.sh <branch-name> --existing # check out a branch that exists
#
# A worktree is a second checkout of this same repo with its own HEAD, so two
# concurrent sessions can never move each other's branch out from under them —
# which is the whole point. See documentation/BRANCH-SAFETY.md.
#
# The worktree lands in .claude/worktrees/<branch-name> (gitignored, so the
# nested checkout is never committed), with node_modules and .env.local
# symlinked back to the primary checkout so `npm run dev` works immediately
# without a second install.
#
# Remove one when you are done with it:
#
#     git worktree remove .claude/worktrees/<branch-name>

set -eu

branch=${1:-}
mode=${2:-}

if [ -z "$branch" ]; then
    echo "usage: scripts/new-worktree.sh <branch-name> [--existing]" >&2
    exit 1
fi

root=$(git rev-parse --show-toplevel)
dir="$root/.claude/worktrees/$branch"

if [ -e "$dir" ]; then
    echo "new-worktree.sh: $dir already exists." >&2
    exit 1
fi

mkdir -p "$root/.claude/worktrees"

if [ "$mode" = "--existing" ]; then
    git -C "$root" worktree add "$dir" "$branch"
else
    # Branch from origin/main where we have it, so a new task starts from the
    # pushed state rather than whatever the primary checkout happens to hold.
    if git -C "$root" rev-parse --verify --quiet origin/main >/dev/null; then
        base=origin/main
    else
        base=main
    fi
    # --no-track matters: branching off origin/main would otherwise set the new
    # branch's upstream to *main*, so a later `git push` argues about main
    # rather than pushing the branch. Push with `git push -u origin <branch>`.
    git -C "$root" worktree add --no-track -b "$branch" "$dir" "$base"
fi

# Shared, expensive, and identical across worktrees.
[ -d "$root/node_modules" ] && ln -sfn "$root/node_modules" "$dir/node_modules"

# Secrets live in one place; symlink so a rotation is picked up everywhere.
for env_file in .env.local .env; do
    [ -f "$root/$env_file" ] && ln -sfn "$root/$env_file" "$dir/$env_file"
done

echo
echo "  worktree ready on branch '$branch':"
echo "    $dir"
echo
echo "  cd into it and start the session there:"
echo "    cd \"$dir\""
echo
