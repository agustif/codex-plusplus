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
export type GitStatusEntry = GitOrdinaryStatusEntry | GitRenameStatusEntry | GitUnmergedStatusEntry | GitUntrackedStatusEntry | GitIgnoredStatusEntry;
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
export declare function createGitMetadataProvider(options?: GitMetadataProviderOptions): GitMetadataProvider;
export {};
