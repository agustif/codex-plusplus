import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";

const DEFAULT_MAX_BYTES = 128 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_TIMEOUT_MS = 5 * 60_000;

export interface SelfMcpConfig {
  root: string;
  userRoot: string | null;
  installerCli: string | null;
}

export function resolveSelfMcpConfig(env: NodeJS.ProcessEnv = process.env): SelfMcpConfig {
  const root = resolveExistingRoot(env.CODEXPP_SELF_ROOT ?? process.cwd());
  return {
    root,
    userRoot: env.CODEXPP_SELF_HOME ? resolve(env.CODEXPP_SELF_HOME) : null,
    installerCli: env.CODEXPP_SELF_CLI ? resolve(env.CODEXPP_SELF_CLI) : inferInstallerCli(root),
  };
}

export function createSelfMcpServer(config: SelfMcpConfig): McpServer {
  const server = new McpServer({
    name: "codexpp-self",
    version: "0.1.0",
  });

  server.registerTool(
    "codexpp_self_status",
    {
      title: "Codex++ Self Status",
      description: "Show the configured self-modification root and current git state.",
    },
    async () => textResult(await statusReport(config)),
  );

  server.registerTool(
    "codexpp_self_list_files",
    {
      title: "Codex++ Self List Files",
      description:
        "List files visible from the Codex++ self root. Uses rg when available and can include ignored files.",
      inputSchema: {
        pattern: z.string().optional(),
        includeIgnored: z.boolean().optional(),
        maxFiles: z.number().int().min(1).max(50_000).optional(),
      },
    },
    async (args) => textResult(await listFiles(config.root, args)),
  );

  server.registerTool(
    "codexpp_self_read",
    {
      title: "Codex++ Self Read",
      description: "Read a file under the Codex++ self root.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().min(0).optional(),
        maxBytes: z.number().int().min(1).max(HARD_MAX_BYTES).optional(),
      },
    },
    async (args) => textResult(readFileWindow(config.root, args.path, args.offset, args.maxBytes)),
  );

  server.registerTool(
    "codexpp_self_search",
    {
      title: "Codex++ Self Search",
      description:
        "Search the full Codex++ self root with ripgrep-compatible options. Use this to map code before editing.",
      inputSchema: {
        query: z.string(),
        glob: z.string().optional(),
        path: z.string().optional(),
        includeIgnored: z.boolean().optional(),
        context: z.number().int().min(0).max(10).optional(),
        maxOutputBytes: z.number().int().min(1_024).max(HARD_MAX_BYTES).optional(),
      },
    },
    async (args) => textResult(await searchCode(config.root, args)),
  );

  server.registerTool(
    "codexpp_self_write",
    {
      title: "Codex++ Self Write",
      description: "Replace or append a file under the Codex++ self root.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        append: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => textResult(writeFileUnderRoot(config.root, args.path, args.content, args.append)),
  );

  server.registerTool(
    "codexpp_self_git_apply",
    {
      title: "Codex++ Self Git Apply",
      description: "Apply a unified git diff to the Codex++ self root with git apply.",
      inputSchema: {
        patch: z.string(),
        check: z.boolean().optional(),
        reverse: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => textResult(await gitApply(config.root, args.patch, args.check, args.reverse)),
  );

  server.registerTool(
    "codexpp_self_shell",
    {
      title: "Codex++ Self Shell",
      description:
        "Run an arbitrary shell command from the Codex++ self root. This is intentionally broad for self-modification experiments.",
      inputSchema: {
        command: z.string(),
        timeoutMs: z.number().int().min(1_000).max(HARD_TIMEOUT_MS).optional(),
        maxOutputBytes: z.number().int().min(1_024).max(HARD_MAX_BYTES).optional(),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      textResult(
        await runShell(config.root, args.command, args.timeoutMs, args.maxOutputBytes),
      ),
  );

  server.registerTool(
    "codexpp_self_runtime_apply",
    {
      title: "Codex++ Self Runtime Apply",
      description:
        "Build/stage the Codex++ runtime into Stable/Beta homes. By default this rebuilds the full repo so installer/self-tool changes are included. With restart=true, backs up the previous runtime, restarts Codex, verifies CDP health, and restores on failure.",
      inputSchema: {
        channel: z.enum(["auto", "stable", "beta", "both"]).optional(),
        restart: z.boolean().optional(),
        build: z.boolean().optional(),
        buildAll: z.boolean().optional(),
        restartSelfMcp: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => textResult(await runtimeApply(config, args)),
  );

  server.registerTool(
    "codexpp_self_restart_mcp",
    {
      title: "Codex++ Self Restart MCP",
      description:
        "Restart the self-MCP worker process so newly staged changes to self-mcp-server.js become active. The launcher respawns it automatically.",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async () => {
      scheduleSelfMcpRestart();
      return textResult(
        process.env.CODEXPP_SELF_LAUNCHER === "1"
          ? "self MCP worker will exit after this response; launcher will respawn it"
          : "self MCP worker will exit after this response; restart the Codex session if the host does not respawn it",
      );
    },
  );

  return server;
}

export function resolveInsideRoot(root: string, path: string): string {
  const full = resolve(root, path || ".");
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (full !== root && !full.startsWith(normalizedRoot)) {
    throw new Error(`path escapes self root: ${path}`);
  }
  return full;
}

export async function statusReport(config: SelfMcpConfig): Promise<string> {
  const rootStat = existsSync(config.root) ? statSync(config.root) : null;
  const git = await runShell(config.root, "git status --short --branch && git rev-parse --show-toplevel", 10_000, 64 * 1024);
  return [
    `root: ${config.root}`,
    `rootExists: ${rootStat ? "true" : "false"}`,
    `userRoot: ${config.userRoot ?? "(unset)"}`,
    `installerCli: ${config.installerCli ?? "(not found)"}`,
    `launcher: ${process.env.CODEXPP_SELF_LAUNCHER === "1" ? "true" : "false"}`,
    `worker: ${process.env.CODEXPP_SELF_WORKER ?? "(direct)"}`,
    "",
    git,
  ].join("\n");
}

export async function listFiles(
  root: string,
  opts: { pattern?: string; includeIgnored?: boolean; maxFiles?: number } = {},
): Promise<string> {
  const maxFiles = opts.maxFiles ?? 2_000;
  const args = ["--files", "--hidden"];
  if (opts.includeIgnored) args.push("--no-ignore");
  args.push("-g", "!.git");
  if (opts.pattern) args.push("-g", opts.pattern);

  const rg = await runCommand("rg", args, root, undefined, 30_000, HARD_MAX_BYTES);
  if (rg.exitCode === 0 || rg.stdout.trim()) {
    return rg.stdout.split("\n").filter(Boolean).slice(0, maxFiles).join("\n");
  }

  const git = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    root,
    undefined,
    30_000,
    HARD_MAX_BYTES,
  );
  return `${git.stdout}${git.stderr ? `\n${git.stderr}` : ""}`
    .split("\n")
    .filter(Boolean)
    .slice(0, maxFiles)
    .join("\n");
}

export function readFileWindow(
  root: string,
  path: string,
  offset = 0,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  const full = resolveInsideRoot(root, path);
  const limit = clampBytes(maxBytes);
  const stat = statSync(full);
  const chunks: Buffer[] = [];
  let remaining = Math.max(0, Math.min(limit, stat.size - offset));

  const fd = readFileSync(full);
  const slice = fd.subarray(offset, offset + remaining);
  chunks.push(slice);
  remaining -= slice.byteLength;

  return [
    `path: ${relative(root, full) || "."}`,
    `size: ${stat.size}`,
    `offset: ${offset}`,
    `bytes: ${limit - remaining}`,
    "",
    Buffer.concat(chunks).toString("utf8"),
  ].join("\n");
}

export async function searchCode(
  root: string,
  opts: {
    query: string;
    glob?: string;
    path?: string;
    includeIgnored?: boolean;
    context?: number;
    maxOutputBytes?: number;
  },
): Promise<string> {
  const searchRoot = resolveInsideRoot(root, opts.path ?? ".");
  const args = ["--line-number", "--column", "--hidden", "--color", "never"];
  if (opts.includeIgnored) args.push("--no-ignore");
  args.push("-g", "!.git");
  if (opts.glob) args.push("-g", opts.glob);
  if (opts.context && opts.context > 0) args.push("--context", String(opts.context));
  args.push("--", opts.query, ".");
  const result = await runCommand("rg", args, searchRoot, undefined, 30_000, opts.maxOutputBytes ?? HARD_MAX_BYTES);
  if (result.exitCode === 1 && !result.stdout && !result.stderr) {
    return "no matches";
  }
  return formatCommandResult(result);
}

export function writeFileUnderRoot(
  root: string,
  path: string,
  content: string,
  append = false,
): string {
  const full = resolveInsideRoot(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, { encoding: "utf8", flag: append ? "a" : "w" });
  const stat = statSync(full);
  return `wrote ${relative(root, full)} (${stat.size} bytes)`;
}

export async function gitApply(
  root: string,
  patch: string,
  check = false,
  reverse = false,
): Promise<string> {
  const args = ["apply", "--whitespace=nowarn"];
  if (check) args.push("--check");
  if (reverse) args.push("--reverse");
  const result = await runCommand("git", args, root, patch, 30_000, HARD_MAX_BYTES);
  return formatCommandResult(result);
}

export async function runtimeApply(
  config: SelfMcpConfig,
  opts: {
    channel?: "auto" | "stable" | "beta" | "both";
    restart?: boolean;
    build?: boolean;
    buildAll?: boolean;
    restartSelfMcp?: boolean;
  },
): Promise<string> {
  const cli = config.installerCli;
  if (!cli || !existsSync(cli)) {
    throw new Error(
      "installer CLI is not built. Run `npm run build --workspace codex-plusplus` or set CODEXPP_SELF_CLI.",
    );
  }
  const output: string[] = [];
  const shouldBuild = opts.build !== false;
  const shouldBuildAll = opts.buildAll ?? shouldBuild;
  if (shouldBuildAll) {
    const build = await runCommand("npm", ["run", "build"], config.root, undefined, HARD_TIMEOUT_MS, HARD_MAX_BYTES);
    output.push(`build all:\n${formatCommandResult(build)}`);
    if (build.exitCode !== 0) return output.join("\n\n");
  }

  const args = [cli, "dev-runtime", "--channel", opts.channel ?? "both", "--no-watch"];
  if (opts.restart) args.push("--restart");
  if (!shouldBuild || shouldBuildAll) args.push("--no-build");
  const result = await runCommand(process.execPath, args, config.root, undefined, HARD_TIMEOUT_MS, HARD_MAX_BYTES);
  output.push(`runtime apply:\n${formatCommandResult(result)}`);
  if (opts.restartSelfMcp) {
    scheduleSelfMcpRestart();
    output.push("self MCP restart scheduled");
  }
  return output.join("\n\n");
}

export async function runShell(
  root: string,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_BYTES,
): Promise<string> {
  return new Promise((resolvePromise) => {
    exec(
      command,
      {
        cwd: root,
        timeout: Math.min(timeoutMs, HARD_TIMEOUT_MS),
        maxBuffer: clampBytes(maxOutputBytes),
        shell: process.env.SHELL || "/bin/sh",
      },
      (error, stdout, stderr) => {
        const errorCode = (error as (Error & { code?: unknown }) | null)?.code;
        const exitCode = typeof errorCode === "number" ? errorCode : error ? 1 : 0;
        resolvePromise(formatCommandResult({ exitCode, stdout, stderr, error }));
      },
    );
  });
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error | null;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  stdin?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_BYTES,
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), Math.min(timeoutMs, HARD_TIMEOUT_MS));
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const max = clampBytes(maxOutputBytes);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes < max) out.push(chunk.subarray(0, Math.max(0, max - outBytes)));
      outBytes += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes < max) err.push(chunk.subarray(0, Math.max(0, max - errBytes)));
      errBytes += chunk.byteLength;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 1, stdout: "", stderr: "", error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });

    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function formatCommandResult(result: CommandResult): string {
  return [
    `exitCode: ${result.exitCode}`,
    result.error ? `error: ${result.error.message}` : null,
    result.stdout ? `\nstdout:\n${result.stdout}` : null,
    result.stderr ? `\nstderr:\n${result.stderr}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function resolveExistingRoot(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function inferInstallerCli(root: string): string | null {
  const candidate = resolve(root, "packages", "installer", "dist", "cli.js");
  return existsSync(candidate) ? candidate : null;
}

function clampBytes(value: number): number {
  return Math.max(1, Math.min(Math.floor(value), HARD_MAX_BYTES));
}

function scheduleSelfMcpRestart(): void {
  const timer = setTimeout(() => process.exit(0), 250);
  timer.unref();
}

if (require.main === module) {
  const server = createSelfMcpServer(resolveSelfMcpConfig());
  server.connect(new StdioServerTransport()).catch((error) => {
    console.error("[codexpp-self] failed to start:", error);
    process.exit(1);
  });
}
