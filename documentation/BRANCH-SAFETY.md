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

The same shared `HEAD` strands work that is not committed yet. A branch
switch takes whatever is in the working tree along with it, so edits made
against one base end up sitting on another, and new files a session has
written are indistinguishable — to somebody else's `git add -A` — from that
person's own. Both are silent when they happen and are noticed much later,
when a file is missing or a commit turns out to hold something it should not.

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
wired up in `.claude/settings.json`, makes two checks. Both block the mistake
*before* any work is done, rather than at commit time, which is what makes
them the layer that renders these errors impossible rather than merely
detectable.

**Work on `main`.** It refuses `Edit`, `Write`, `NotebookEdit` and any Bash
`git commit` while `main` is checked out. It judges by where the change would
land — an edit is checked against the branch of the checkout containing the
target file, so a worktree is judged by its own `HEAD` rather than by the
session's working directory.

```bash
CLAUDE_ALLOW_MAIN_EDITS=1 claude    # a session that may touch main
```

**`HEAD` surgery over uncommitted work.** It refuses `git checkout`, `git
switch`, `git reset` and `git stash` **in the primary checkout** while its
working tree is dirty — the case where the changes about to be carried or
shelved may belong to another session. Worktrees are exempt: a worktree
belongs to one task, so its `HEAD` is nobody else's to lose. Untracked files
count as dirty, since those are exactly what a stray `git add -A` sweeps into
an unrelated commit.

```bash
CLAUDE_ALLOW_DIRTY_SWITCH=1 claude  # a session that may move a dirty HEAD
```

Two families deliberately pass: path-limited restores (`git checkout --
src/x.ts`), which leave `HEAD` alone and name their targets, and branch
creation in place (`git switch -c`, `git checkout -b`), which carries the
working tree onto a branch of its own and is the fix for this situation
rather than an instance of it.

Anything else passes silently. Both checks judge a Bash command by the
session's working directory, so a command that reaches into another checkout
with `git -C <dir>` is invisible to them; that case is covered by the
"never run git in a checkout you don't own" agreement, not by the hook.

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

That symlinks the tracked scripts into the common git directory, so edits to
the tracked copies take effect immediately and every worktree is covered by
the single install. Run it again whenever a hook is added, since it only
installs the ones it knows about. The symlinks always point into the primary
checkout, even when the script is run from a worktree — a worktree is removed
when its task lands, and a symlink into one would leave every checkout
silently unhooked.

To make a deliberate commit to `main`:

```bash
ALLOW_MAIN_COMMIT=1 git commit -m "..."
```

## Layer 4 — the `post-checkout` warning (all switches)

[`scripts/git-hooks/post-checkout`](../scripts/git-hooks/post-checkout) prints
a loud warning when a branch switch carried uncommitted changes across with
it, listing the tracked and untracked paths and the commit they were written
against.

It exists because half the danger is out of reach of Layer 2. `guard-branch.sh`
is a Claude Code `PreToolUse` hook, so it only ever sees tool calls Claude
makes; a person running `git checkout` in their own terminal is invisible to
it. Git has no `pre-checkout` hook to block from, only `post-checkout` — so
this is a notification, not a block, and it is deliberately the loudest thing
in the file.

The test is exact rather than heuristic. A checkout never *creates* changes,
so anything dirty afterwards was dirty before and came along. The hook stays
quiet when the commit did not move — `git switch -c my-branch`, or a switch
between two branches at the same tip — because the diff still applies to the
same base and nothing has been stranded. That exemption matters: creating a
branch in place is precisely the recommended way *out* of this.

It installs alongside the `pre-commit` hook, from the same one-off run.

## Habits that still matter

The layers above are mechanical, and they only cover *where* work lands.
Two things remain worth doing:

- **Name the branch when you start a thread.** "This is for
  `resolve-url-redirects`" costs one sentence and removes the ambiguity that
  the guards can only fail loudly about, not resolve.
- **Commit early and often.** Layers 2 and 4 refuse and report the moves that
  strand uncommitted work, but neither can put it back, and neither sees a
  `git add -A` that sweeps up somebody else's new files. A small uncommitted
  window is still a small blast radius.
