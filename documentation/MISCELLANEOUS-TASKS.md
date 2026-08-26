# Miscellaneous tasks

A running list of small pieces of work that don't belong to any one subsystem
and have no plan document of their own. Each entry should carry enough detail
to be picked up cold — what the problem is, why it isn't already handled, and
what a fix would have to do.

Move an item out into its own doc once it grows past a section, and delete it
once it ships.

---

## 1. Uncommitted work when a checkout is shared

**Status:** covered as far as it can be, 2026-08-26. What is left is one item
that needs machinery git does not have, and it is listed under *What is still
uncovered*. First seen 2026-07-24.

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

### What is in place

Five layers, described in full in [BRANCH-SAFETY.md](BRANCH-SAFETY.md). In the
order they were built:

- **A worktree per task** (`scripts/new-worktree.sh`), which removes the shared
  `HEAD` outright. Prevention rather than protection: it does nothing on the
  occasions the primary checkout is still shared.
- **`guard-branch.sh` refuses `HEAD` surgery over a dirty primary checkout** —
  `git checkout`, `git switch`, `git reset`, `git stash` — and **refuses
  indiscriminate staging there too** — `git add -A`, `git add .`, `git commit
  -a`. Path-limited restores, branch creation in place and `git add -u` still
  pass. Escape hatch: `CLAUDE_ALLOW_DIRTY_PRIMARY=1`.
- **`post-checkout` warns** when a switch carried uncommitted changes, and
  when the stash grew since the branch last moved. It fires in whoever's
  terminal ran the switch, so it covers the human side that no `PreToolUse`
  hook can see.
- **A `Stop` hook reports** work left uncommitted in the primary checkout at
  the end of each turn, so the exposure window is at least visible while it is
  open. Warning only — auto-committing work in progress was considered and
  rejected, because it buys a smaller window at the cost of a history that has
  to be squashed before every PR.

`scripts/git-hooks/hooks.test.mjs` exercises all of it against a real scratch
repository. Most of the cases pin the forms that must *not* be caught, since a
false positive would train people to ignore the guard. Existing clones need
`scripts/git-hooks/install.sh` re-run to pick up the git hooks.

### What is still uncovered

- **A person's own `git add -A`, in their own terminal.** This is the one
  genuine remaining hole, and it is the one the original entry called the most
  work: `pre-commit` can see the staged list but has no notion of which paths
  belong to which session, so it cannot tell a legitimate broad commit from a
  sweep. The Claude Code side is covered by `guard-branch.sh`; the human side
  would need session-ownership tracking that git does not have, and that a
  `PostToolUse` recorder could not supply reliably either, since a session
  that writes files through `Bash` heredocs never touches `Edit` or `Write`.
- **Commands that change directory before running git.** `guard-branch.sh`
  follows `git -C <dir>` and sees through git's global options, but `cd
  elsewhere && git switch …` is still judged by where the session started, as
  is a `-C` path containing a space. Both fall back to allowing. Covered by
  the "never run git in a checkout you don't own" agreement only.

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

Both `git checkout ... -- <paths>` forms above are deliberately exempt from the
guard, so recovery works without reaching for the escape hatch.

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
a pattern like `\]\(([A-Z0-9_-]+\.md)\)` silently missed
`PROPOSAL-organisations.md` (since renamed to `ORGANISATIONS.md`), because
that filename mixed upper and lower case. The specific file is gone, but the
lesson isn't: use `[\w.-]+\.md` and compare against the real directory
listing rather than assuming a naming shape.

### Worth deciding at the same time

Whether the index should list `.md` files outside `documentation/` — the root
`README.md` and `CLAUDE.md`, which are the two deliberate exceptions to the
"all markdown lives in `documentation/`" rule. `CLAUDE.md` is linked once from the
index preamble in prose; the root `README.md` is not linked at all. Neither
appears in a table.

---

## 3. Directory search matches, but doesn't rank — and drops foreign-script aliases

**Status:** open. Measured 2026-08-26, against 4,146 approved artists.

Both halves below were deferred out of the `normalise_name_key` work, which
fixed the *correctness* of the search key (a search for "ØTTA" was normalising
to `tta`) and deliberately left *quality* alone. Neither is a bug: the search
returns the right set in an unhelpful order, and one narrow class of input
finds nothing.

### 3a. Results come back in alphabetical order, not relevance order

`getArtists()` in `src/lib/queries.ts` applies `.order("name")` and nothing
else. A substring match on `name_search` is a boolean — every hit is equally
good as far as the query is concerned — so the artist you searched for sorts
wherever the alphabet puts them. Searching `vel` puts the artist actually
called **Vel** behind anything alphabetically earlier that contains those three
letters, potentially pages behind, since pagination is 24 at a time with no
total count.

The "Exact match" checkbox is a partial escape, but it asks the visitor to
already know the full name and to notice the checkbox. It is a filter, not a
ranking.

A fix has to rank in SQL. The `hasMore` pagination fetches `PAGE_SIZE + 1` rows
and slices, so ordering cannot be applied to a page after the fact — by then
the wrong 24 rows have already been chosen. The natural shape is exact, then
prefix, then substring, then trigram similarity:

```sql
order by
  (name_search = :term) desc,
  (name_search like :term || '%') desc,
  similarity(name_search, :term) desc,
  name
```

Two things to check before committing to that. `similarity()` needs `pg_trgm`'s
operators, which the existing GIN indexes
(`idx_artists_name_search_trgm_approved`, `idx_artist_aliases_name_search_trgm`)
support, but a sort on `similarity()` is not itself index-accelerated — it ranks
whatever the `ILIKE` filter already returned, so the filter must stay selective.
And the alias branch currently merges two result sets by id, which gives an
alias hit no rank of its own; ranking probably wants the whole thing
restructured as one RPC returning ranked ids, which the existing query builder
then hydrates with `.in("id", ids)`, leaving `ARTIST_SELECT` untouched.

This one needs judgement against real result sets, not just a passing test.

### 3b. An artist can't be found by a foreign-script alias

`name_search` is built on `unaccent()`, which is Latin-only. A name in
Cyrillic, Japanese, Chinese or Arabic romanises to nothing and stores an empty
key, so it can never be matched. `getArtists()` correctly returns an empty page
rather than letting the empty `LIKE` pattern match every row, but "correctly
nothing" is still nothing.

Measured, the exposure is small, and not where it was assumed to be:

| | count | note |
|---|---|---|
| approved artists with an empty `name_search` | **1** of 4,146 | `𝒛𝒊!` — mathematical-script Latin, not a foreign script |
| `artist_aliases` rows with an empty `name_search` | **10** of 554 | Вера, 女皇, アルカ, クリスタル・ウォーターズ, بريندا الريس, … |

So no approved artist is unreachable: every one of those ten has a Latin
primary name that finds them. What is lost is the alias itself. An
`artist_aliases` row exists precisely so that someone typing the other name
finds the artist — for these ten, typing `アルカ` returns nothing though the row
is right there.

The single primary-name case is not a script problem at all: `𝒛𝒊!` is "zi!" in
Unicode mathematical script letters. NFKD would fold it to `zi`, but the
pipeline uses NFD deliberately, because that is what matches Postgres. Changing
it would break the parity the whole `src/lib/name-key.mjs` design rests on, so
this one is a curiosity, not a motivation.

The cheap fix is a raw-name fallback: when `normalisedNameKey(term)` is empty,
match the untouched term against `artists.name` and `artist_aliases.name` with
`ILIKE` instead of giving up. No schema change, no new dependency, and it
covers all eleven rows. There is no index on the raw `name` columns, so it is a
sequential scan — acceptable on a rare path over 4,146 rows, and worth
measuring rather than assuming.

Transliteration at ingest is the thorough alternative, and is more work than it
looks: the useful mapping for アルカ is "Arca", which is a translation of a
name, not a romanisation of its characters (アルカ transliterates to *aruka*).
Any library will give the second.

---

## 4. The branch guard denies worktree commits from a `main`-based session

**Status:** open. Hit three times on 2026-08-26, including while writing this
entry; worked around each time.

### What goes wrong

`scripts/git-hooks/guard-branch.sh` refuses commits landing on `main`. For
`Edit`/`Write` it resolves the branch from the *target file's* checkout, so a
worktree is correctly judged by its own `HEAD`. For `Bash` it does this
instead:

```sh
Bash)
    case "$command" in *"git commit"*) ;; *) exit 0 ;; esac
    dir=$(pwd)
```

Two separate defects fall out of those two lines.

**The directory is wrong.** `pwd` is the hook process's own working directory —
the session's — not the directory the command will run in. A commit inside a
worktree is therefore judged by wherever the session happens to be sitting.
With the primary checkout on `main`, its normal resting state, both of these
are denied:

```
git -C /path/to/worktree commit -m …        # judged by the session's pwd
cd /path/to/worktree && git commit -m …     # the cd is inside the command
```

The denial then recommends `scripts/new-worktree.sh` — which is exactly what
was already done.

It is not absolute, which is worse than if it were. A bare `cd` into the
worktree as its **own** command, in a previous call, moves the shell's working
directory, and the next call's hook sees the worktree. So the guard passes or
fails on whether the `cd` happened in a prior tool call or the same one — not a
distinction anyone can reasonably hold in their head.

**The match is too broad.** The `case` is a substring test against the whole
command line, so anything merely *containing* the text — grepping for it,
echoing it, appending documentation that discusses it — is treated as a commit
and judged accordingly. Writing this entry tripped it: the first attempt to
append this section was refused, because the heredoc quoted the two denied
commands above. Documenting the guard is blocked by the guard.

### Why it matters more than the inconvenience

A guard that misfires on the recommended workflow trains people to route around
it, and the routes around it are worse than the guard: forcing a throwaway `cd`
call, or reaching for `CLAUDE_ALLOW_MAIN_EDITS=1` — the documented escape hatch
for *deliberately* working on `main`, which is not what is happening and which
disables the real check too.

This also lands on the proposal in entry 1 to extend `guard-branch.sh` to
`git checkout` / `git switch` / `git reset` / `git stash`. Any such extension
inherits both defects, and for those commands a wrong answer is worse than a
refused commit.

### What a fix would have to do

Resolve the directory the command will actually run in, rather than the one the
hook starts in. In rough order of preference:

- **Parse `git -C <path>`.** The explicit form is unambiguous, and it is the
  form worth encouraging when several checkouts are in play. A short
  `case`/`sed` over the command covers it.
- **Parse a leading `cd <path> &&`.** Covers the other common shape. Both are
  string matching on a command line and neither is airtight — quoting,
  `pushd`, `$VAR` paths — but each failure lands on the *existing* behaviour,
  so it is strictly an improvement.
- **Tighten the matcher** so it fires on a command that runs a commit rather
  than one that mentions one. Anchoring to the start of the command or to a
  `;`/`&&`/`|` boundary would have avoided the heredoc case.
- **Drop the `Bash` arm entirely and rely on `pre-commit`.** That hook runs
  inside the real repository and already judges the branch correctly for every
  commit, whether from Claude or a person's terminal. The `PreToolUse` arm buys
  a faster, clearer refusal; it does not buy any coverage. Deleting it trades a
  little friction for the removal of a whole class of wrong answer.

Whichever way it goes, [BRANCH-SAFETY.md](BRANCH-SAFETY.md) describes the
`Bash` arm as judged "by cwd" and should say what that means for worktrees.
