import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitMetadataProvider } from "../src/git-metadata";

test("resolveRepository and getStatus report a clean repository", async () => {
  await withTempGitRepo(async ({ repo }) => {
    const provider = createGitMetadataProvider({ timeoutMs: 10_000 });

    const resolved = await provider.resolveRepository(repo);
    const status = await provider.getStatus(repo);

    assert.equal(resolved.found, true);
    assert.equal(resolved.root, repo);
    assert.equal(resolved.headBranch, "main");
    assert.match(resolved.headSha ?? "", /^[0-9a-f]{40}$/);
    assert.equal(status.clean, true);
    assert.deepEqual(status.entries, []);
    assert.equal(status.branch.head, "main");
    assert.equal(status.truncated, false);
  });
});

test("getStatus parses dirty and untracked porcelain v2 entries", async () => {
  await withTempGitRepo(async ({ repo }) => {
    writeFileSync(join(repo, "tracked.txt"), "first\nsecond\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const provider = createGitMetadataProvider({ timeoutMs: 10_000 });

    const status = await provider.getStatus(repo);

    assert.equal(status.clean, false);
    assert.equal(status.truncated, false);
    assert.deepEqual(
      status.entries.map((entry) => [entry.kind, entry.path]),
      [
        ["ordinary", "tracked.txt"],
        ["untracked", "new.txt"],
      ],
    );
    const tracked = status.entries.find((entry) => entry.kind === "ordinary");
    assert.equal(tracked?.index, ".");
    assert.equal(tracked?.worktree, "M");
  });
});

test("getDiffSummary summarizes tracked changes against HEAD", async () => {
  await withTempGitRepo(async ({ repo }) => {
    writeFileSync(join(repo, "tracked.txt"), "first\nsecond\nthird\n");
    const provider = createGitMetadataProvider({ timeoutMs: 10_000 });

    const summary = await provider.getDiffSummary(repo);

    assert.equal(summary.truncated, false);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.insertions, 2);
    assert.equal(summary.deletions, 0);
    assert.deepEqual(summary.files[0], {
      path: "tracked.txt",
      oldPath: null,
      insertions: 2,
      deletions: 0,
      binary: false,
    });
  });
});

test("getDiffSummary preserves raw paths for tabs, newlines, and renames", async () => {
  await withTempGitRepo(async ({ repo }) => {
    const tabbedPath = "tab\tfile.txt";
    const oldPath = "old\tname.txt";
    const newPath = "new\nname.txt";
    writeFileSync(join(repo, tabbedPath), "alpha\n");
    writeFileSync(join(repo, oldPath), "one\n");
    git(repo, ["add", tabbedPath, oldPath]);
    git(repo, ["commit", "-m", "add edge paths"]);
    writeFileSync(join(repo, tabbedPath), "alpha\nbeta\n");
    git(repo, ["mv", oldPath, newPath]);
    writeFileSync(join(repo, newPath), "one\ntwo\n");
    const provider = createGitMetadataProvider({ timeoutMs: 10_000 });

    const summary = await provider.getDiffSummary(repo);

    assert.equal(summary.truncated, false);
    assert.equal(
      summary.files.some((file) => file.path === tabbedPath && file.oldPath === null),
      true,
    );
    assert.equal(
      summary.files.some((file) => file.path === newPath && file.oldPath === oldPath),
      true,
    );
  });
});

test("getWorktrees parses git worktree porcelain output", async () => {
  await withTempGitRepo(async ({ repo, root }) => {
    const linked = join(root, "repo-linked");
    git(repo, ["worktree", "add", "-b", "linked", linked]);
    const provider = createGitMetadataProvider({ timeoutMs: 10_000 });

    const worktrees = await provider.getWorktrees(repo);

    assert.deepEqual(
      worktrees.map((worktree) => worktree.path).sort(),
      [linked, repo].sort(),
    );
    assert.equal(
      worktrees.some((worktree) => worktree.branch === "refs/heads/linked"),
      true,
    );
  });
});

test("resolveRepository reports bare repositories", async () => {
  await withTempDir(async ({ root }) => {
    const bare = join(root, "bare.git");
    git(root, ["init", "--bare", "-b", "main", bare]);
    const provider = createGitMetadataProvider({ timeoutMs: 10_000 });

    const resolved = await provider.resolveRepository(bare);
    const status = await provider.getStatus(bare);

    assert.equal(resolved.found, true);
    assert.equal(resolved.isBare, true);
    assert.equal(resolved.isInsideWorkTree, false);
    assert.equal(resolved.root, null);
    assert.equal(resolved.gitDir, bare);
    assert.equal(status.clean, true);
    assert.deepEqual(status.entries, []);
  });
});

test("getStatus marks capped stdout as truncated", async () => {
  await withTempGitRepo(async ({ repo }) => {
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(repo, `untracked-${index}.txt`), "x\n");
    }
    const provider = createGitMetadataProvider({
      timeoutMs: 10_000,
      maxStdoutBytes: 512,
    });

    const status = await provider.getStatus(repo);

    assert.equal(status.clean, false);
    assert.equal(status.truncated, true);
    assert.equal(status.entries.length > 0, true);
  });
});

async function withTempDir(fn: (paths: { root: string }) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codexpp-git-metadata-")));
  try {
    await fn({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempGitRepo(fn: (paths: { root: string; repo: string }) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codexpp-git-metadata-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  try {
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "codex@example.com"]);
    git(repo, ["config", "user.name", "Codex Test"]);
    writeFileSync(join(repo, "tracked.txt"), "first\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "initial"]);

    await fn({ root, repo });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
