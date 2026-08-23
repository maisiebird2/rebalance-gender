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

---

## 2. The documentation index has drifted, and nothing checks it

**Status:** open. Measured 2026-08-23.

### What's missing

`documentation/README.md` is the index every other doc is found through, and
it is maintained by hand. Two of the 22 files in `documentation/` are absent
from it:

| Doc | Referenced from |
|---|---|
| `BRANCH-SAFETY.md` | `CLAUDE.md`, `scripts/git-hooks/guard-branch.sh`, `scripts/git-hooks/pre-commit`, `scripts/new-worktree.sh`, `.gitignore`, `MISCELLANEOUS-TASKS.md` |
| `SECURITY-HEADERS.md` | `next.config.mjs`, `src/proxy.ts` |

`BRANCH-SAFETY.md` is the sharper miss. Six files point at it — more inbound
references than any other doc in the repo — and it is the explanation behind a
working agreement in `CLAUDE.md` that hard-blocks edits. Someone arriving at
the index to find out why their edit was refused will not find it there.

`SECURITY-HEADERS.md` is cited only from code, so it is invisible to anyone
reading documentation on its own.

No entry points the other way: every link in the index resolves to a file that
exists.

### Why it drifted

Nothing enforces the index. There is no test, and `.github/` is empty, so
there is no CI to run one from either. A new doc is only indexed if whoever
wrote it remembered — and the two that slipped are both infrastructure notes
written alongside code changes, where the index isn't in view.

### What a fix would have to do

Two parts, worth doing together.

**Add the missing rows.** This needs one small decision: neither doc fits the
existing sections. `Subsystems` is about the data pipeline (genres, matching,
scoring), and neither of these is data. Options are a new section — *Working
practice*, or *Infrastructure* — or a looser reading of `Subsystems`. A new
section is probably right; `BRANCH-SAFETY.md` and `SECURITY-HEADERS.md` are
both "how a mechanism in this repo works", which is a real category the index
currently has no home for.

**Make it self-checking.** A vitest case that fails when
`documentation/*.md` and the links in `documentation/README.md` disagree, in
both directions:

- every `.md` in `documentation/` except `README.md` is linked from the index;
- every `.md` the index links to exists.

The project already runs `vitest run` via `npm test`, with 21 test files
alongside the code they cover, so a `documentation/index.test.mjs` — or a case
inside an existing suite — needs no new tooling. Note that with no CI, this
only fires when someone runs `npm test` locally; wiring up a workflow is a
separate job.

One implementation trap, hit while measuring this: matching link targets with
a pattern like `\]\(([A-Z0-9_-]+\.md)\)` silently misses
`PROPOSAL-organisations.md`, because the filenames mix upper and lower case.
Use `[\w.-]+\.md` and compare against the real directory listing rather than
assuming a naming shape.

### Worth deciding at the same time

Whether the index should list `.md` files outside `documentation/` — the root
`README.md` and `CLAUDE.md`, which are the two deliberate exceptions to the
"all markdown lives in `documentation/`" rule. `CLAUDE.md` is linked once from the
index preamble in prose; the root `README.md` is not linked at all. Neither
appears in a table.
