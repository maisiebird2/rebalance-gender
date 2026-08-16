# Branch safety

How this repo stops work from landing on the wrong branch when several
sessions are open at once.

## The problem this solves

Git's current branch is a property of **the directory on disk**, not of
whoever is working in it. Every session pointed at the primary checkout
shares one `HEAD`. So if one session runs `git checkout scrape-images`, the
next commit from a different session lands there — and that session has no
way to notice, because it checked the branch before the state moved
underneath it.

That is a shared-mutable-state problem, not a discipline problem. No amount
of "remember to check the branch first" fixes it, because the check and the
commit are not atomic.

Software teams do not hit this, because each person has their own clone on
their own machine: one checkout per worker. The three layers below reproduce
that property, and then fail loudly when it is bypassed.

## Layer 1 — one worktree per concurrent task

A worktree is a second directory with its own `HEAD`, checked out to its own
branch, backed by the same repository and history. Two sessions in two
worktrees cannot move each other's branch, so the whole class of bug
disappears.

```bash
scripts/new-worktree.sh my-branch-name
```

That creates `.claude/worktrees/my-branch-name`, branched from `origin/main`,
with `node_modules` and `.env.local` symlinked back to the primary checkout so
it builds and runs immediately. Start the session inside that directory.

Pass `--existing` to check out a branch that already exists instead of
creating one.

Clean up when the work has landed:

```bash
git worktree remove .claude/worktrees/my-branch-name
```

If a worktree directory gets deleted by hand, its registration lingers —
`git worktree prune` clears the stale entries.

The rule that goes with this: **the primary checkout is for reading and for
`main`.** Anything you intend to commit happens in a worktree, or at minimum
on a branch.

## Layer 2 — the PreToolUse guard (Claude Code)

[`scripts/git-hooks/guard-branch.sh`](../scripts/git-hooks/guard-branch.sh),
wired up in `.claude/settings.json`, refuses `Edit`, `Write`, `NotebookEdit`
and any Bash `git commit` while `main` is checked out. It judges by where the
change would land — an edit is checked against the branch of the checkout
containing the target file, so a worktree is judged by its own `HEAD` rather
than by the session's working directory.

This one blocks the mistake *before* any work is done, rather than at commit
time. It is the layer that makes wrong-branch edits impossible rather than
merely detectable.

Anything not on `main` passes silently. To deliberately run a session that may
touch `main`:

```bash
CLAUDE_ALLOW_MAIN_EDITS=1 claude
```

`.claude/` is otherwise gitignored; `.claude/settings.json` is excepted
specifically so this wiring survives a fresh clone.

## Layer 3 — the `pre-commit` hook (all commits)

[`scripts/git-hooks/pre-commit`](../scripts/git-hooks/pre-commit) rejects any
commit made while `main` is checked out. It is the catch-all: it fires for
commits made by hand, by any tool, and from any worktree, including sessions
that never load `.claude/settings.json`.

Install once per clone:

```bash
scripts/git-hooks/install.sh
```

That symlinks the tracked script into the common git directory, so edits to
the tracked copy take effect immediately and every worktree is covered by the
single install.

To make a deliberate commit to `main`:

```bash
ALLOW_MAIN_COMMIT=1 git commit -m "..."
```

## Habits that still matter

The layers above are mechanical, and they only cover *where* work lands.
Two things remain worth doing:

- **Name the branch when you start a thread.** "This is for
  `resolve-url-redirects`" costs one sentence and removes the ambiguity that
  the guards can only fail loudly about, not resolve.
- **Commit early and often.** An uncommitted working tree is the one piece of
  state no guard protects. A small uncommitted window is a small blast radius.
