#!/bin/sh
#
# Install this repo's git hooks by symlinking them into the common git
# directory, so the tracked copies under scripts/git-hooks/ stay the source of
# truth and edits take effect immediately.
#
# Run once per clone:
#
#     scripts/git-hooks/install.sh
#
# Worktrees share the common git directory, so one run covers them all.

set -eu

root=$(git rev-parse --show-toplevel)
common=$(git rev-parse --git-common-dir)

# --git-common-dir can come back relative to the cwd; make it absolute.
case "$common" in
    /*) ;;
    *) common="$(pwd)/$common" ;;
esac

mkdir -p "$common/hooks"

for hook in pre-commit; do
    src="$root/scripts/git-hooks/$hook"
    dest="$common/hooks/$hook"

    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "install.sh: $dest exists and is not a symlink — leaving it alone." >&2
        echo "            Merge it with $src by hand, then re-run." >&2
        exit 1
    fi

    chmod +x "$src"
    ln -sfn "$src" "$dest"
    echo "installed $hook -> $src"
done
