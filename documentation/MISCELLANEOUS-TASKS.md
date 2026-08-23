# Miscellaneous tasks

A running list of small pieces of work that don't belong to any one subsystem
and have no plan document of their own. Each entry should carry enough detail
to be picked up cold — what the problem is, why it isn't already handled, and
what a fix would have to do.

Move an item out into its own doc once it grows past a section, and delete it
once it ships.

---

## 1. Uncommitted work is unprotected when a checkout is shared

**Status:** open, unmitigated in code. First seen 2026-07-24; still live as of
2026-08-23.

### What goes wrong

Two agents — or an agent and a person working in their own terminal — share
the primary checkout. Git's `HEAD` belongs to the *directory*, not to the
conversation, so a branch operation by one party moves the ground under the
other. Two mechanisms have actually bitten:

- **A branch switch strands tracked edits.** One session has edits in the
  working tree that are not yet committed. Someone else runs `git checkout` /
  `git switch` in the same checkout. The edits either follow the switch onto
  an unrelated branch or get stashed out of the way, and the session that made
  them carries on believing they are still in place.
- **`git add -A` sweeps up untracked files.** New files a session has written
  but not yet committed are indistinguishable, to another party's `git add -A`
  or `git add .`, from that party's own new work. They land in an unrelated
  commit on an unrelated branch.

Both are silent at the moment they happen. They are typically noticed later,
when a file is missing or a commit turns out to contain something it should
not.

### Why the existing guards don't catch it

`scripts/git-hooks/guard-branch.sh` (PreToolUse) and
`scripts/git-hooks/pre-commit` both ask exactly one question: *is the branch
called `main`?* Everything else passes silently. See
[BRANCH-SAFETY.md](BRANCH-SAFETY.md).

That leaves this failure entirely uncovered, for three separate reasons:

1. **It happens on feature branches.** Both mechanisms play out between two
   non-`main` branches, so the branch-name test never fires.
2. **The guards protect committed work, not uncommitted work.** They govern
   where a commit is allowed to land. Neither looks at the state of the
   working tree, and no check runs at the moment a branch is switched.
3. **Half the danger is outside any hook's reach.** `guard-branch.sh` is a
   Claude Code `PreToolUse` hook, so it only ever sees tool calls Claude
   itself makes. A person running `git checkout` in their own terminal is
   invisible to it. Git has no `pre-checkout` hook to fall back on — only
   `post-checkout`, which runs after the damage is done.

### What a fix would have to do

Nothing here is decided; these are the candidate directions, roughly in
increasing order of cost.

- **Make sharing rare rather than safe.** A worktree per task removes the
  shared `HEAD` outright, which is why it is already the working agreement in
  [../CLAUDE.md](../CLAUDE.md). This is prevention, not protection, and it
  does nothing on the occasions the primary checkout is still shared.
- **Reduce the exposure window.** A `Stop` hook that commits work-in-progress
  to the session's own branch at the end of each turn would mean there is
  rarely anything uncommitted to strand. Needs a decision on what to do with
  the resulting noise — squash before the PR, or a `wip:` prefix that a
  pre-push hook refuses.
- **Warn after the fact.** A `post-checkout` hook can compare the working tree
  against what it looked like before, and print a loud warning when a switch
  carried or stashed uncommitted changes. Cheap, and it covers a person's
  terminal as well as Claude's, but it is a notification, not a block.
- **Block the agent's half.** Extend `guard-branch.sh` to deny `git checkout`,
  `git switch`, `git reset` and `git stash` in the primary checkout when the
  working tree is dirty. Only constrains Claude, which is the half that can be
  constrained. Overlaps with the "never run git in a checkout you don't own"
  rule that already exists as guidance.
- **Narrow the staging blast radius.** A `pre-commit` check that refuses
  `git add -A`-style commits containing files outside the paths this session
  has touched. The most targeted option and the most work, since it needs a
  notion of session-owned paths that git does not have.

A realistic first pass is the `post-checkout` warning plus the
`guard-branch.sh` extension: together they cover both mechanisms for the agent
side and give the human side a visible signal, without needing session
ownership tracking.

### Recovery, if it happens again

The work is virtually never lost — it is misplaced, and both hiding places are
recoverable:

```
git stash list                        # the switch may have stashed the edits
git checkout stash@{0} -- <paths>     # pull specific files back out

git log --oneline --all -- <path>     # find the commit that swallowed them
git checkout <sha> -- <paths>         # restore from that commit
```

`git fsck --lost-found` is the last resort if neither turns it up.

### Provenance

The 2026-07-24 incident is recorded from a memory note rather than from a
post-mortem in this repo; the note captured the two mechanisms and the
recovery commands above, not the specific files involved. The guard analysis
in this entry was re-derived from the current hook sources on 2026-08-23.
