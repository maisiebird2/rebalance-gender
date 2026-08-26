import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooks = path.dirname(fileURLToPath(import.meta.url));

// A scratch repository the hooks can be exercised against for real, so the
// tests check what git actually does rather than a re-implementation of it.
//
// Two branches whose tips differ, because "did the commit move?" is the
// question post-checkout turns on. They differ in a file of their own rather
// than in tracked.txt, so an uncommitted edit to tracked.txt can survive the
// switch — git refuses outright to carry changes that would be overwritten,
// and it is the changes it *does* carry that this hook exists to report.
function makeRepo({ withHook = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hooks-test-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "tracked.txt"), "one\n");
  git("add", "tracked.txt");
  git("commit", "--quiet", "-m", "first");
  git("switch", "--quiet", "-c", "other");
  writeFileSync(path.join(dir, "only-on-other.txt"), "elsewhere\n");
  git("add", "only-on-other.txt");
  git("commit", "--quiet", "-m", "second");
  git("switch", "--quiet", "main");

  if (withHook) {
    mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
    symlinkSync(path.join(hooks, "post-checkout"), path.join(dir, ".git", "hooks", "post-checkout"));
  }
  return { dir, git };
}

// Run guard-branch.sh over a tool call. Returns the reason it refused, or
// null when it passed silently — the text matters, because three separate
// checks can refuse and a test that only asserted "deny" would not notice one
// firing in place of another.
function guard(toolInput, { cwd, env = {} } = {}) {
  const result = spawnSync("sh", [path.join(hooks, "guard-branch.sh")], {
    input: JSON.stringify(toolInput),
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_ALLOW_MAIN_EDITS: "",
      CLAUDE_ALLOW_DIRTY_PRIMARY: "",
      CLAUDE_ALLOW_DIRTY_SWITCH: "",
      ...env,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  if (!result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

describe("guard-branch.sh: work on main", () => {
  let repo;
  beforeAll(() => { repo = makeRepo(); });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("denies an edit to a file in a checkout on main", () => {
    const call = { tool_name: "Edit", tool_input: { file_path: path.join(repo.dir, "tracked.txt") } };
    expect(guard(call)).toMatch(/not allowed to land there/);
  });

  it("allows the same edit once the checkout is off main", () => {
    repo.git("switch", "--quiet", "other");
    const call = { tool_name: "Edit", tool_input: { file_path: path.join(repo.dir, "tracked.txt") } };
    expect(guard(call)).toBe(null);
    repo.git("switch", "--quiet", "main");
  });

  it("denies a commit run from a checkout on main", () => {
    expect(guard(bash("git commit -m x"), { cwd: repo.dir })).toMatch(/not allowed to land there/);
  });

  it("passes a commit through under CLAUDE_ALLOW_MAIN_EDITS", () => {
    expect(guard(bash("git commit -m x"), { cwd: repo.dir, env: { CLAUDE_ALLOW_MAIN_EDITS: "1" } })).toBe(null);
  });
});

describe("guard-branch.sh: HEAD surgery over a dirty primary checkout", () => {
  let repo;
  beforeAll(() => {
    repo = makeRepo();
    repo.git("switch", "--quiet", "other");           // off main, so only check 2 can fire
    writeFileSync(path.join(repo.dir, "tracked.txt"), "dirty\n");
  });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  const denied = ["git checkout main", "git switch main", "git reset --hard", "git stash", "cd sub && git switch main"];
  for (const command of denied) {
    it(`denies \`${command}\``, () => {
      expect(guard(bash(command), { cwd: repo.dir })).toMatch(/can strand work/);
    });
  }

  // Forms that leave HEAD where it is, or that rescue the changes rather than
  // strand them. These are the ones a false positive would be most costly on:
  // two of them are what the guard's own message tells you to run.
  const allowed = [
    "git switch -c rescue",
    "git checkout -b rescue",
    "git checkout -- tracked.txt",
    "git checkout stash@{0} -- tracked.txt",
    "git stash list",
    "git stash show -p",
    "git status",
    "git log --oneline",
  ];
  for (const command of allowed) {
    it(`allows \`${command}\``, () => {
      expect(guard(bash(command), { cwd: repo.dir })).toBe(null);
    });
  }

  it("passes through under CLAUDE_ALLOW_DIRTY_PRIMARY", () => {
    expect(guard(bash("git switch main"), { cwd: repo.dir, env: { CLAUDE_ALLOW_DIRTY_PRIMARY: "1" } })).toBe(null);
  });

  it("still honours CLAUDE_ALLOW_DIRTY_SWITCH, the name this shipped under", () => {
    expect(guard(bash("git switch main"), { cwd: repo.dir, env: { CLAUDE_ALLOW_DIRTY_SWITCH: "1" } })).toBe(null);
  });

  it("counts untracked files as dirty, since those are what `git add -A` sweeps up", () => {
    repo.git("checkout", "--", "tracked.txt");
    writeFileSync(path.join(repo.dir, "new-file.txt"), "mine\n");
    expect(guard(bash("git switch main"), { cwd: repo.dir })).toMatch(/can strand work/);
  });

  it("allows a switch when the tree is clean", () => {
    rmSync(path.join(repo.dir, "new-file.txt"));
    expect(guard(bash("git switch main"), { cwd: repo.dir })).toBe(null);
  });

  it("exempts a worktree, whose HEAD belongs to one task", () => {
    const tree = path.join(repo.dir, "wt");
    repo.git("worktree", "add", "--quiet", "-b", "wt-branch", tree);
    writeFileSync(path.join(tree, "tracked.txt"), "dirty in the worktree\n");
    expect(guard(bash("git switch other"), { cwd: tree })).toBe(null);
  });
});

describe("guard-branch.sh: indiscriminate staging in a dirty primary checkout", () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo();
    repo.git("switch", "--quiet", "other");           // off main, so only check 3 can fire
    writeFileSync(path.join(repo.dir, "someone-elses-notes.md"), "not mine\n");
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const denied = ["git add -A", "git add --all", "git add .", "git add :/", 'git commit -am "x"', 'git commit --all -m "x"'];
  for (const command of denied) {
    it(`denies \`${command}\``, () => {
      expect(guard(bash(command), { cwd: repo.dir })).toMatch(/staging sweep/);
    });
  }

  // Staging by name is the behaviour being asked for, and `git add -u` is
  // limited to files already tracked, so neither can pick up a stray new file.
  const allowed = ["git add tracked.txt", "git add -u", 'git commit -m "x"', "git add --dry-run -A"];
  for (const command of allowed) {
    it(`allows \`${command}\``, () => {
      expect(guard(bash(command), { cwd: repo.dir })).toBe(null);
    });
  }

  it("allows a sweep when the tree is clean", () => {
    rmSync(path.join(repo.dir, "someone-elses-notes.md"));
    expect(guard(bash("git add -A"), { cwd: repo.dir })).toBe(null);
  });

  it("exempts a worktree", () => {
    const tree = path.join(repo.dir, "wt");
    repo.git("worktree", "add", "--quiet", "-b", "wt-branch", tree);
    writeFileSync(path.join(tree, "mine.md"), "mine\n");
    expect(guard(bash("git add -A"), { cwd: tree })).toBe(null);
  });

  it("passes through under CLAUDE_ALLOW_DIRTY_PRIMARY", () => {
    expect(guard(bash("git add -A"), { cwd: repo.dir, env: { CLAUDE_ALLOW_DIRTY_PRIMARY: "1" } })).toBe(null);
  });
});

describe("guard-branch.sh: which checkout a command acts on", () => {
  let repo, tree;
  beforeEach(() => {
    repo = makeRepo();
    repo.git("switch", "--quiet", "other");
    tree = path.join(repo.dir, "wt");
    repo.git("worktree", "add", "--quiet", "-b", "wt-branch", tree);
    writeFileSync(path.join(repo.dir, "tracked.txt"), "dirty in the primary\n");
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("follows `git -C` into the primary checkout from a worktree", () => {
    expect(guard(bash(`git -C ${repo.dir} switch main`), { cwd: tree })).toMatch(/can strand work/);
  });

  it("follows `git -C` out to a worktree from the primary checkout", () => {
    expect(guard(bash(`git -C ${tree} switch main`), { cwd: repo.dir })).toBe(null);
  });

  it("judges a `git -C` commit by the branch of the checkout it names", () => {
    // The cwd sits on `other`; the named worktree is on `wt-branch`; neither
    // is main, so a check that read the wrong one would still pass here.
    // Point it at a checkout that *is* on main and the difference shows.
    repo.git("worktree", "add", "--quiet", "--detach", path.join(repo.dir, "wt2"));
    execFileSync("git", ["-C", path.join(repo.dir, "wt2"), "switch", "--quiet", "main"]);
    expect(guard(bash(`git -C ${path.join(repo.dir, "wt2")} commit -m x`), { cwd: tree }))
      .toMatch(/not allowed to land there/);
  });

  // The subcommand has to be found before any of the checks can match it, and
  // a global option sits between it and `git`.
  for (const command of ["git -C DIR switch main", "git --no-pager -C DIR switch main", "git -c core.pager=cat -C DIR switch main"]) {
    it(`sees the subcommand through \`${command.replace(" DIR", "")}\``, () => {
      expect(guard(bash(command.replace("DIR", repo.dir)), { cwd: tree })).toMatch(/can strand work/);
    });
  }

  it("is not fooled by an unrelated -C flag, such as `grep -C`", () => {
    // `grep -C 3` must not be read as naming a directory. If it were, the
    // lookup would fail and the guard would fall through to allowing this.
    expect(guard(bash("grep -C 3 needle haystack && git switch main"), { cwd: repo.dir }))
      .toMatch(/can strand work/);
  });

  it("falls back to the working directory when `git -C` names nothing that exists", () => {
    expect(guard(bash("git -C /no/such/place switch main"), { cwd: repo.dir })).toMatch(/can strand work/);
  });
});

describe("post-checkout: changes carried across a switch", () => {
  // A fresh repository per case: these tests move HEAD around, and one
  // leaving the tree dirty would quietly decide the next one's outcome.
  let repo;
  beforeEach(() => { repo = makeRepo({ withHook: true }); });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  // git writes hook output to stderr, so that is where the warning shows up.
  const switchTo = (...args) =>
    spawnSync("git", ["-C", repo.dir, "switch", ...args], { encoding: "utf8" }).stderr;

  it("warns when a switch to another commit carries uncommitted changes", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "uncommitted\n");
    const stderr = switchTo("other");
    expect(stderr).toContain("carried uncommitted changes");
    expect(stderr).toContain("tracked.txt");
  });

  it("calls out untracked files separately", () => {
    writeFileSync(path.join(repo.dir, "stray.txt"), "mine\n");
    const stderr = switchTo("other");
    expect(stderr).toContain("Untracked");
    expect(stderr).toContain("stray.txt");
  });

  it("stays quiet when the tree is clean", () => {
    expect(switchTo("other")).not.toContain("carried uncommitted changes");
  });

  it("stays quiet for a branch created in place, which is the way out, not the fault", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "uncommitted\n");
    expect(switchTo("-c", "rescued")).not.toContain("carried uncommitted changes");
  });

  it("stays quiet for a path-limited checkout, which moves no branch", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "uncommitted\n");
    const stderr = spawnSync("git", ["-C", repo.dir, "checkout", "--", "tracked.txt"], { encoding: "utf8" }).stderr;
    expect(stderr).not.toContain("carried uncommitted changes");
  });
});

describe("post-checkout: work shelved into the stash", () => {
  let repo;
  beforeEach(() => {
    repo = makeRepo({ withHook: true });
    repo.git("switch", "--quiet", "other");   // establishes the baseline count
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const switchTo = (...args) =>
    spawnSync("git", ["-C", repo.dir, "switch", ...args], { encoding: "utf8" }).stderr;

  it("warns when the stash has grown since this checkout last moved", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "someone else's work\n");
    repo.git("stash", "--quiet");
    const stderr = switchTo("main");
    expect(stderr).toContain("stashed in this checkout");
    expect(stderr).toContain("tracked.txt");
  });

  it("lists untracked files that were stashed with -u", () => {
    writeFileSync(path.join(repo.dir, "stray.txt"), "mine\n");
    repo.git("stash", "--quiet", "--include-untracked");
    expect(switchTo("main")).toContain("stray.txt");
  });

  it("stays quiet when the stash has not grown", () => {
    expect(switchTo("main")).not.toContain("stashed in this checkout");
  });

  it("stays quiet when the stash shrank, which is a pop putting work back", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "work\n");
    repo.git("stash", "--quiet");
    switchTo("main");                          // warns, and records a count of 1
    repo.git("stash", "pop", "--quiet");
    repo.git("checkout", "--", "tracked.txt");
    expect(switchTo("other")).not.toContain("stashed in this checkout");
  });

  it("records the count it saw, so the same stash is not reported twice", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "work\n");
    repo.git("stash", "--quiet");
    expect(switchTo("main")).toContain("stashed in this checkout");
    expect(existsSync(path.join(repo.dir, ".git", "rebalance-last-stash-count"))).toBe(true);
    expect(switchTo("other")).not.toContain("stashed in this checkout");
  });

  it("stays quiet in a worktree, where a stash could only be your own", () => {
    const tree = path.join(repo.dir, "wt");
    repo.git("worktree", "add", "--quiet", "-b", "wt-branch", tree);
    symlinkSync(path.join(hooks, "post-checkout"), path.join(repo.dir, ".git", "hooks", "post-checkout-x"));
    writeFileSync(path.join(repo.dir, "tracked.txt"), "work\n");
    repo.git("stash", "--quiet");
    const stderr = spawnSync("git", ["-C", tree, "switch", "main"], { encoding: "utf8" }).stderr;
    expect(stderr).not.toContain("stashed in this checkout");
  });
});

describe("stop-dirty-tree.sh", () => {
  let repo;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  // Returns the systemMessage the hook asked Claude Code to show, or null.
  function stop(cwd) {
    const result = spawnSync("sh", [path.join(hooks, "stop-dirty-tree.sh")], {
      input: JSON.stringify({ session_id: "test", stop_hook_active: false }),
      cwd,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    if (!result.stdout.trim()) return null;
    const parsed = JSON.parse(result.stdout);
    // It must never block the turn from ending.
    expect(parsed.decision).toBeUndefined();
    return parsed.systemMessage;
  }

  it("stays quiet when the primary checkout is clean", () => {
    expect(stop(repo.dir)).toBe(null);
  });

  it("reports uncommitted work in the primary checkout", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "in progress\n");
    writeFileSync(path.join(repo.dir, "notes.md"), "in progress\n");
    const message = stop(repo.dir);
    expect(message).toContain("2 uncommitted files");
    expect(message).toContain("tracked.txt");
    expect(message).toContain("notes.md");
    expect(message).toContain("main");
  });

  it("agrees with itself about singular and plural", () => {
    writeFileSync(path.join(repo.dir, "tracked.txt"), "in progress\n");
    expect(stop(repo.dir)).toContain("1 uncommitted file in");
  });

  it("stays quiet in a worktree, which belongs to one task", () => {
    const tree = path.join(repo.dir, "wt");
    repo.git("worktree", "add", "--quiet", "-b", "wt-branch", tree);
    writeFileSync(path.join(tree, "tracked.txt"), "in progress\n");
    expect(stop(tree)).toBe(null);
  });

  it("stays quiet outside a repository altogether", () => {
    expect(stop(tmpdir())).toBe(null);
  });
});
