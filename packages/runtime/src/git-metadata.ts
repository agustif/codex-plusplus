import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

type GitFailureKind = "not-a-repository" | "git-failed" | "timeout" | "spawn-error";

export interface GitMetadataProviderOptions {
  gitPath?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface GitRepositoryResolution {
  found: boolean;
  inputPath: string;
  root: string | null;
  gitDir: string | null;
  commonDir: string | null;
  isInsideWorkTree: boolean;
  isBare: boolean;
  headBranch: string | null;
  headSha: string | null;
  error: GitCommandError | null;
}

export interface GitStatus {
  repository: GitRepositoryResolution;
  clean: boolean;
  branch: GitStatusBranch;
  entries: GitStatusEntry[];
  truncated: boolean;
}

export interface GitStatusBranch {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export type GitStatusEntry =
  | GitOrdinaryStatusEntry
  | GitRenameStatusEntry
  | GitUnmergedStatusEntry
  | GitUntrackedStatusEntry
  | GitIgnoredStatusEntry;

export interface GitOrdinaryStatusEntry {
  kind: "ordinary";
  path: string;
  index: string;
  worktree: string;
  submodule: string;
}

export interface GitRenameStatusEntry {
  kind: "rename";
  path: string;
  originalPath: string;
  index: string;
  worktree: string;
  submodule: string;
  score: string;
}

export interface GitUnmergedStatusEntry {
  kind: "unmerged";
  path: string;
  index: string;
  worktree: string;
  submodule: string;
}

export interface GitUntrackedStatusEntry {
  kind: "untracked";
  path: string;
}

export interface GitIgnoredStatusEntry {
  kind: "ignored";
  path: string;
}

export interface GitDiffSummary {
  repository: GitRepositoryResolution;
  files: GitDiffFileSummary[];
  fileCount: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
}

export interface GitDiffFileSummary {
  path: string;
  oldPath: string | null;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

export interface GitCommandError {
  kind: GitFailureKind;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  message: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface GitMetadataProvider {
  resolveRepository(path: string): Promise<GitRepositoryResolution>;
  getStatus(path: string): Promise<GitStatus>;
  getDiffSummary(path: string): Promise<GitDiffSummary>;
  getWorktrees(path: string): Promise<GitWorktree[]>;
}

interface RunGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error: Error | null;
}

interface ParseTokenCursor {
  tokens: string[];
  index: number;
}

export function createGitMetadataProvider(
  options: GitMetadataProviderOptions = {},
): GitMetadataProvider {
  const config = normalizeOptions(options);

  return {
    resolveRepository(path) {
      return resolveRepository(path, config);
    },
    async getStatus(path) {
      const repository = await resolveRepository(path, config);
      if (!repository.found || !repository.root || !repository.isInsideWorkTree) {
        return {
          repository,
          clean: repository.found && repository.isBare,
          branch: emptyBranch(),
          entries: [],
          truncated: false,
        };
      }

      const args = [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
      ];
      const result = await runGit(args, repository.root, config);
      if (!result.ok) {
        const error = commandError(result, config.gitPath, args);
        return {
          repository: { ...repository, error },
          clean: false,
          branch: emptyBranch(),
          entries: [],
          truncated: result.stdoutTruncated,
        };
      }

      const parsed = parsePorcelainV2Status(result.stdout);
      return {
        repository,
        clean: parsed.entries.length === 0 && !result.stdoutTruncated,
        branch: parsed.branch,
        entries: parsed.entries,
        truncated: result.stdoutTruncated,
      };
    },
    async getDiffSummary(path) {
      const repository = await resolveRepository(path, config);
      if (!repository.found || !repository.root || !repository.isInsideWorkTree) {
        return {
          repository,
          files: [],
          fileCount: 0,
          insertions: 0,
          deletions: 0,
          truncated: false,
        };
      }

      const args = repository.headSha
        ? ["diff", "--numstat", "-z", "--find-renames", "--find-copies", "HEAD", "--"]
        : ["diff", "--numstat", "-z", "--cached", "--find-renames", "--find-copies", "--"];
      const result = await runGit(args, repository.root, config);
      if (!result.ok) {
        const error = commandError(result, config.gitPath, args);
        return {
          repository: { ...repository, error },
          files: [],
          fileCount: 0,
          insertions: 0,
          deletions: 0,
          truncated: result.stdoutTruncated,
        };
      }

      const files = parseNumstat(result.stdout);
      return {
        repository,
        files,
        fileCount: files.length,
        insertions: sumKnown(files.map((file) => file.insertions)),
        deletions: sumKnown(files.map((file) => file.deletions)),
        truncated: result.stdoutTruncated,
      };
    },
    async getWorktrees(path) {
      const repository = await resolveRepository(path, config);
      const cwd = repository.root ?? repository.gitDir;
      if (!repository.found || !cwd) return [];
      const result = await runGit(["worktree", "list", "--porcelain", "-z"], cwd, config);
      if (!result.ok) return [];
      return parseWorktrees(result.stdout);
    },
  };
}

async function resolveRepository(
  inputPath: string,
  config: Required<GitMetadataProviderOptions>,
): Promise<GitRepositoryResolution> {
  const args = [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--is-inside-work-tree",
    "--is-bare-repository",
  ];
  const result = await runGit(args, inputPath, config);
  if (!result.ok) {
    return {
      found: false,
      inputPath,
      root: null,
      gitDir: null,
      commonDir: null,
      isInsideWorkTree: false,
      isBare: false,
      headBranch: null,
      headSha: null,
      error: commandError(result, config.gitPath, args, "not-a-repository"),
    };
  }

  const [gitDir = null, commonDir = null, inside = "false", bare = "false"] =
    result.stdout.trimEnd().split(/\r?\n/);
  const isInsideWorkTree = inside === "true";
  const isBare = bare === "true";
  const root = isInsideWorkTree
    ? await readOptionalGitLine(["rev-parse", "--path-format=absolute", "--show-toplevel"], inputPath, config)
    : null;
  const cwd = root ?? gitDir ?? inputPath;
  const [headBranch, headSha] = await Promise.all([
    readOptionalGitLine(["symbolic-ref", "--short", "-q", "HEAD"], cwd, config),
    readOptionalGitLine(["rev-parse", "--verify", "HEAD"], cwd, config),
  ]);

  return {
    found: true,
    inputPath,
    root,
    gitDir,
    commonDir,
    isInsideWorkTree,
    isBare,
    headBranch,
    headSha,
    error: null,
  };
}

async function readOptionalGitLine(
  args: string[],
  cwd: string,
  config: Required<GitMetadataProviderOptions>,
): Promise<string | null> {
  const result = await runGit(args, cwd, config);
  if (!result.ok) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function parsePorcelainV2Status(stdout: string): { branch: GitStatusBranch; entries: GitStatusEntry[] } {
  const branch = emptyBranch();
  const cursor: ParseTokenCursor = { tokens: splitNul(stdout), index: 0 };
  const entries: GitStatusEntry[] = [];

  while (cursor.index < cursor.tokens.length) {
    const token = cursor.tokens[cursor.index++];
    if (!token) continue;

    if (token.startsWith("# ")) {
      parseBranchHeader(branch, token);
      continue;
    }

    if (token.startsWith("1 ")) {
      const parts = token.split(" ");
      const path = parts.slice(8).join(" ");
      if (path) {
        entries.push({
          kind: "ordinary",
          index: parts[1]?.[0] ?? ".",
          worktree: parts[1]?.[1] ?? ".",
          submodule: parts[2] ?? "N...",
          path,
        });
      }
      continue;
    }

    if (token.startsWith("2 ")) {
      const parts = token.split(" ");
      const path = parts.slice(9).join(" ");
      const originalPath = cursor.tokens[cursor.index++] ?? "";
      if (path) {
        entries.push({
          kind: "rename",
          index: parts[1]?.[0] ?? ".",
          worktree: parts[1]?.[1] ?? ".",
          submodule: parts[2] ?? "N...",
          score: parts[8] ?? "",
          path,
          originalPath,
        });
      }
      continue;
    }

    if (token.startsWith("u ")) {
      const parts = token.split(" ");
      const path = parts.slice(10).join(" ");
      if (path) {
        entries.push({
          kind: "unmerged",
          index: parts[1]?.[0] ?? "U",
          worktree: parts[1]?.[1] ?? "U",
          submodule: parts[2] ?? "N...",
          path,
        });
      }
      continue;
    }

    if (token.startsWith("? ")) {
      entries.push({ kind: "untracked", path: token.slice(2) });
      continue;
    }

    if (token.startsWith("! ")) {
      entries.push({ kind: "ignored", path: token.slice(2) });
    }
  }

  return { branch, entries };
}

function parseBranchHeader(branch: GitStatusBranch, header: string): void {
  const body = header.slice(2);
  const space = body.indexOf(" ");
  const key = space === -1 ? body : body.slice(0, space);
  const value = space === -1 ? "" : body.slice(space + 1);

  switch (key) {
    case "branch.oid":
      branch.oid = value === "(initial)" ? null : value;
      break;
    case "branch.head":
      branch.head = value === "(detached)" ? null : value;
      break;
    case "branch.upstream":
      branch.upstream = value || null;
      break;
    case "branch.ab": {
      const match = value.match(/^\+(-?\d+) -(-?\d+)$/);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      break;
    }
  }
}

function parseNumstat(stdout: string): GitDiffFileSummary[] {
  const files: GitDiffFileSummary[] = [];
  const tokens = splitNul(stdout);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const header = parseNumstatHeader(token);
    if (!header) continue;
    const { insertionsRaw, deletionsRaw } = header;
    const pathRaw = header.pathRaw || tokens[++index] || "";
    if (!pathRaw) continue;
    const oldPath = header.pathRaw ? null : pathRaw;
    const path = header.pathRaw ? pathRaw : tokens[++index] || pathRaw;
    const binary = insertionsRaw === "-" || deletionsRaw === "-";
    files.push({
      path,
      oldPath,
      insertions: binary ? null : Number(insertionsRaw),
      deletions: binary ? null : Number(deletionsRaw),
      binary,
    });
  }
  return files;
}

function parseNumstatHeader(
  token: string,
): { insertionsRaw: string; deletionsRaw: string; pathRaw: string } | null {
  const firstTab = token.indexOf("\t");
  if (firstTab === -1) return null;
  const secondTab = token.indexOf("\t", firstTab + 1);
  if (secondTab === -1) return null;
  return {
    insertionsRaw: token.slice(0, firstTab),
    deletionsRaw: token.slice(firstTab + 1, secondTab),
    pathRaw: token.slice(secondTab + 1),
  };
}

function parseWorktrees(stdout: string): GitWorktree[] {
  const tokens = splitNul(stdout);
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  for (const token of tokens) {
    if (!token) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }

    const [key, value] = splitFirst(token, " ");
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockedReason: null,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }

    if (!current) continue;
    switch (key) {
      case "HEAD":
        current.head = value || null;
        break;
      case "branch":
        current.branch = value || null;
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = true;
        current.lockedReason = value || null;
        break;
      case "prunable":
        current.prunable = true;
        current.prunableReason = value || null;
        break;
    }
  }

  if (current) worktrees.push(current);
  return worktrees;
}

function splitNul(value: string): string[] {
  const tokens = value.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

function splitFirst(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function sumKnown(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function emptyBranch(): GitStatusBranch {
  return {
    oid: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
  };
}

function normalizeOptions(options: GitMetadataProviderOptions): Required<GitMetadataProviderOptions> {
  return {
    gitPath: options.gitPath ?? "git",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
  };
}

function runGit(
  args: string[],
  cwd: string,
  config: Required<GitMetadataProviderOptions>,
): Promise<RunGitResult> {
  return new Promise((resolve) => {
    const child = spawn(config.gitPath, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 500).unref();
    }, config.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = config.maxStdoutBytes - stdoutLength;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutLength += remaining;
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLength += chunk.length;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = config.maxStderrBytes - stderrLength;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrLength += remaining;
        stderrTruncated = true;
        return;
      }
      stderrChunks.push(chunk);
      stderrLength += chunk.length;
    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: !spawnError && !timedOut && exitCode === 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        error: spawnError,
      });
    });
  });
}

function commandError(
  result: RunGitResult,
  command: string,
  args: string[],
  fallbackKind: GitFailureKind = "git-failed",
): GitCommandError {
  const kind: GitFailureKind = result.error
    ? "spawn-error"
    : result.timedOut
      ? "timeout"
      : fallbackKind;
  const stderr = result.stderr.trim();
  return {
    kind,
    command,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    message: result.error?.message ?? (stderr || `git ${args.join(" ")} failed`),
    stderr,
    timedOut: result.timedOut,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}
