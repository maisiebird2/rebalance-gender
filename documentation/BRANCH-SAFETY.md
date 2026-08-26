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
wired up in `.claude/settings.json`, makes three checks. All of them block the
mistake *before* any work is done, rather than at commit time, which is what
makes this the layer that renders these errors impossible rather than merely
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
shelved may belong to another session.

Two families deliberately pass: path-limited restores (`git checkout --
src/x.ts`), which leave `HEAD` alone and name their targets, and branch
creation in place (`git switch -c`, `git checkout -b`), which carries the
working tree onto a branch of its own and is the fix for this situation
rather than an instance of it.

**Indiscriminate staging.** It refuses `git add -A`, `git add --all`, `git add
.`, `git add :/`, `git commit -a` and `git commit --all` **in the primary
checkout** while its working tree is dirty. A sweep cannot tell this session's
new files from anybody else's — they are identical to git — so somebody else's
work lands in your commit and disappears from where they left it. Stage by
name instead. `git add -u` passes, since it only touches files already
tracked, and so does `git commit` with paths.

Both of those checks are for the primary checkout only. Worktrees are exempt:
a worktree belongs to one task, so its working tree is nobody else's to lose.
Untracked files count as dirty in both — those are the ones a sweep picks up.

```bash
CLAUDE_ALLOW_DIRTY_PRIMARY=1 claude  # may move or sweep a dirty primary
```

`CLAUDE_ALLOW_DIRTY_SWITCH` is the name that hatch shipped under when the
`HEAD` check was the only one behind it. It is still honoured.

Anything else passes silently. A Bash command is judged by the directory it
acts on: an explicit `git -C <dir>` where there is one, otherwise the
session's working directory. git's global options (`-C`, `-c`, `--no-pager`)
are folded away before the command is read, so they cannot hide the
subcommand. A command that changes directory first — `cd elsewhere && git
switch …` — is still judged by where the session started, and a `-C` path
containing a space is read only as far as the space; both fall back to
allowing. This is a guard against accidents, and the "never run git in a
checkout you don't own" agreement is what covers the rest.

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

[`scripts/git-hooks/post-checkout`](../scripts/git-hooks/post-checkout) exists
because half the danger is out of reach of Layer 2. `guard-branch.sh` is a
Claude Code `PreToolUse` hook, so it only ever sees tool calls Claude makes; a
person running `git checkout` in their own terminal is invisible to it. Git
has no `pre-checkout` hook to block from, only `post-checkout` — so this is a
notification, not a block, and it is deliberately the loudest thing in the
file. It prints two warnings.

**Changes carried across.** When a switch took uncommitted changes with it,
the hook lists the tracked and untracked paths and the commit they were
written against. The test is exact rather than heuristic: a checkout never
*creates* changes, so anything dirty afterwards was dirty before and came
along. It stays quiet when the commit did not move — `git switch -c
my-branch`, or a switch between two branches at the same tip — because the
diff still applies to the same base and nothing has been stranded. That
exemption matters: creating a branch in place is precisely the recommended way
*out* of this.

**Work shelved into the stash.** `git stash push` fires no hook of its own, so
the hook records how tall the stash was each time the branch moved and reports
it when it has grown, listing what is in the newest entry. This half is for
the primary checkout only: a stash you made yourself is something you already
know about, so in a worktree it could only ever be noise. `git stash pop` does
fire `post-checkout`, but as a *file* checkout, so it cannot mask the entry it
restores.

Both warnings address the same blind spot. The person who ran the command
never saw the changes they moved, so they cannot know whose they were — which
is why the paths are listed. Recognising your own work in the list takes a
second, and not recognising it is the whole signal.

It installs alongside the `pre-commit` hook, from the same one-off run.

## Layer 5 — the `Stop` hook (end of every turn)

[`scripts/git-hooks/stop-dirty-tree.sh`](../scripts/git-hooks/stop-dirty-tree.sh),
wired up in `.claude/settings.json`, reports work left uncommitted in the
primary checkout when a turn ends.

The other layers refuse and report the operations that strand uncommitted
work; none of them can put it back. The only real defence is for the work not
to be sitting there when somebody else's `git checkout` or `git add -A`
arrives, and this is the cheap way to close that gap: a reminder, every turn,
for as long as it is exposed.

It warns rather than committing anything. Auto-committing work in progress was
the other candidate, and it buys a smaller window at the cost of a history
that has to be squashed before every PR; a warning has no blast radius at all.
It never blocks the turn from ending.

The primary checkout only, and deliberately so. That is the checkout sessions
share, and per [../CLAUDE.md](../CLAUDE.md) it is for reading and for `main`,
so there should rarely be anything uncommitted in it and a warning about one
is worth reading. Warning about a worktree's uncommitted tree would fire on
every turn of ordinary work until it was ignored.

## Habits that still matter

The layers above are mechanical, and they only cover *where* work lands.
Two things remain worth doing:

- **Name the branch when you start a thread.** "This is for
  `resolve-url-redirects`" costs one sentence and removes the ambiguity that
  the guards can only fail loudly about, not resolve.
- **Commit early and often.** Layers 2, 4 and 5 refuse, report and remind, but
  none of them can put stranded work back, and none of them sees a person's
  own `git add -A` in their own terminal. A small uncommitted window is still
  a small blast radius.
