#!/bin/sh
#
# Install this repo's git hooks by symlinking them into the common git
# directory, so the tracked copies under scripts/git-hooks/ stay the source of
# truth and edits take effect immediately.
#
# Run once per clone — and again whenever a hook is added here, since this only
# installs the ones it knows about:
#
#     scripts/git-hooks/install.sh
#
# Worktrees share the common git directory, so one run covers them all. For the
# same reason the symlinks always point into the *primary* checkout, even when
# this is run from a worktree: a worktree is removed when its task lands, and a
# symlink into one would leave every checkout silently unhooked.

set -eu

common=$(git rev-parse --git-common-dir)

# --git-common-dir can come back relative to the cwd; make it absolute.
case "$common" in
    /*) ;;
    *) common="$(pwd)/$common" ;;
esac

# The primary checkout is the first entry `git worktree list` reports.
root=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -n 1)

mkdir -p "$common/hooks"

for hook in pre-commit post-checkout; do
    src="$root/scripts/git-hooks/$hook"
    dest="$common/hooks/$hook"

    # A hook added on a branch that the primary checkout has not merged yet.
    # Symlinking it would dangle; say so and carry on with the rest.
    if [ ! -f "$src" ]; then
        echo "install.sh: $hook is missing from the primary checkout — skipping." >&2
        echo "            Re-run once $root is on a branch that has it." >&2
        continue
    fi

    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "install.sh: $dest exists and is not a symlink — leaving it alone." >&2
        echo "            Merge it with $src by hand, then re-run." >&2
        exit 1
    fi

    chmod +x "$src"
    ln -sfn "$src" "$dest"
    echo "installed $hook -> $src"
done
