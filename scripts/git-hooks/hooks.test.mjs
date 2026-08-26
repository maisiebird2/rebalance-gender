import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
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

// Run guard-branch.sh over a tool call and return its permission decision,
// or null when it passed silently.
function guard(toolInput, { cwd, env = {} } = {}) {
  const result = spawnSync("sh", [path.join(hooks, "guard-branch.sh")], {
    input: JSON.stringify(toolInput),
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_ALLOW_MAIN_EDITS: "", CLAUDE_ALLOW_DIRTY_SWITCH: "", ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  if (!result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout);
  return parsed.hookSpecificOutput.permissionDecision;
}

describe("guard-branch.sh: work on main", () => {
  let repo;
  beforeAll(() => { repo = makeRepo(); });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("denies an edit to a file in a checkout on main", () => {
    const call = { tool_name: "Edit", tool_input: { file_path: path.join(repo.dir, "tracked.txt") } };
    expect(guard(call)).toBe("deny");
  });

  it("allows the same edit once the checkout is off main", () => {
    repo.git("switch", "--quiet", "other");
    const call = { tool_name: "Edit", tool_input: { file_path: path.join(repo.dir, "tracked.txt") } };
    expect(guard(call)).toBe(null);
    repo.git("switch", "--quiet", "main");
  });

  it("denies a commit run from a checkout on main", () => {
    const call = { tool_name: "Bash", tool_input: { command: "git commit -m x" } };
    expect(guard(call, { cwd: repo.dir })).toBe("deny");
  });

  it("passes a commit through under CLAUDE_ALLOW_MAIN_EDITS", () => {
    const call = { tool_name: "Bash", tool_input: { command: "git commit -m x" } };
    expect(guard(call, { cwd: repo.dir, env: { CLAUDE_ALLOW_MAIN_EDITS: "1" } })).toBe(null);
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
      expect(guard({ tool_name: "Bash", tool_input: { command } }, { cwd: repo.dir })).toBe("deny");
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
      expect(guard({ tool_name: "Bash", tool_input: { command } }, { cwd: repo.dir })).toBe(null);
    });
  }

  it("passes through under CLAUDE_ALLOW_DIRTY_SWITCH", () => {
    const call = { tool_name: "Bash", tool_input: { command: "git switch main" } };
    expect(guard(call, { cwd: repo.dir, env: { CLAUDE_ALLOW_DIRTY_SWITCH: "1" } })).toBe(null);
  });

  it("counts untracked files as dirty, since those are what `git add -A` sweeps up", () => {
    repo.git("checkout", "--", "tracked.txt");
    writeFileSync(path.join(repo.dir, "new-file.txt"), "mine\n");
    const call = { tool_name: "Bash", tool_input: { command: "git switch main" } };
    expect(guard(call, { cwd: repo.dir })).toBe("deny");
  });

  it("allows a switch when the tree is clean", () => {
    rmSync(path.join(repo.dir, "new-file.txt"));
    const call = { tool_name: "Bash", tool_input: { command: "git switch main" } };
    expect(guard(call, { cwd: repo.dir })).toBe(null);
  });

  it("exempts a worktree, whose HEAD belongs to one task", () => {
    const tree = path.join(repo.dir, "wt");
    repo.git("worktree", "add", "--quiet", "-b", "wt-branch", tree);
    writeFileSync(path.join(tree, "tracked.txt"), "dirty in the worktree\n");
    const call = { tool_name: "Bash", tool_input: { command: "git switch other" } };
    expect(guard(call, { cwd: tree })).toBe(null);
  });
});

describe("post-checkout", () => {
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
