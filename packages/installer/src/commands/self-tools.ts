import kleur from "kleur";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { stageAssets } from "./install.js";

export const SELF_MCP_MANAGED_START = "# BEGIN CODEX++ SELF MCP SERVER";
export const SELF_MCP_MANAGED_END = "# END CODEX++ SELF MCP SERVER";

interface SelfToolsOpts {
  root?: string;
  name?: string;
  config?: string;
  disable?: boolean;
  quiet?: boolean;
}

interface PersistedConfig {
  codexPlusPlus?: {
    selfTools?: {
      enabled?: boolean;
      root?: string;
      serverName?: string;
      configuredAt?: string;
    };
  };
}

export function selfTools(opts: SelfToolsOpts = {}): void {
  const paths = ensureUserPaths();
  const serverName = opts.name ?? "codexpp-self";
  const codexConfigPath = resolveCodexConfigPath(opts.config);

  if (opts.disable === true) {
    writeSelfToolsConfig(paths.configFile, { enabled: false, root: null, serverName });
    updateSelfMcpBlock(codexConfigPath, "");
    if (opts.quiet !== true) console.log(kleur.green("Disabled Codex++ self tools."));
    return;
  }

  stageAssets(paths.runtime);
  const root = resolve(opts.root ?? process.cwd());
  const serverPath = join(paths.runtime, "self-mcp-server.js");
  const launcherPath = join(paths.runtime, "self-mcp-launcher.js");
  if (!existsSync(serverPath)) {
    throw new Error(`self MCP server was not staged: ${serverPath}`);
  }
  if (!existsSync(launcherPath)) {
    throw new Error(`self MCP launcher was not staged: ${launcherPath}`);
  }

  writeSelfToolsConfig(paths.configFile, { enabled: true, root, serverName });
  updateSelfMcpBlock(
    codexConfigPath,
    formatSelfMcpBlock({
      serverName,
      launcherPath,
      serverPath,
      root,
      userRoot: paths.root,
      installerCli: inferInstallerCli(root),
    }),
  );

  if (opts.quiet !== true) {
    console.log(kleur.green().bold("✓ Codex++ self tools enabled"));
    console.log(`  MCP server: ${kleur.cyan(serverName)} via ${kleur.cyan("self-mcp-launcher.js")}`);
    console.log(`  Root:       ${kleur.cyan(root)}`);
    console.log(`  Config:     ${kleur.cyan(codexConfigPath)}`);
    console.log(kleur.dim("Restart Codex/Codex CLI sessions so they reload MCP tools."));
  }
}

export function formatSelfMcpBlock({
  serverName,
  launcherPath,
  serverPath,
  root,
  userRoot,
  installerCli,
}: {
  serverName: string;
  launcherPath: string;
  serverPath: string;
  root: string;
  userRoot: string;
  installerCli: string | null;
}): string {
  const env: Record<string, string> = {
    CODEXPP_SELF_ROOT: root,
    CODEXPP_SELF_HOME: userRoot,
    CODEXPP_SELF_WORKER: serverPath,
  };
  if (installerCli) env.CODEXPP_SELF_CLI = installerCli;

  return [
    SELF_MCP_MANAGED_START,
    `[mcp_servers.${formatTomlKey(serverName)}]`,
    `command = ${formatTomlString("node")}`,
    `args = ${formatTomlStringArray([launcherPath])}`,
    `env = ${formatTomlInlineTable(env)}`,
    SELF_MCP_MANAGED_END,
  ].join("\n");
}

export function mergeSelfMcpBlock(currentToml: string, block: string): string {
  const stripped = stripSelfMcpBlock(currentToml).trimEnd();
  if (!block) return stripped ? `${stripped}\n` : "";
  return `${stripped ? `${stripped}\n\n` : ""}${block}\n`;
}

export function stripSelfMcpBlock(toml: string): string {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(SELF_MCP_MANAGED_START)}[\\s\\S]*?${escapeRegExp(SELF_MCP_MANAGED_END)}\\n?`,
    "g",
  );
  return toml.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function updateSelfMcpBlock(configPath: string, block: string): void {
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = mergeSelfMcpBlock(current, block);
  if (next === current) return;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next, "utf8");
}

function writeSelfToolsConfig(
  configPath: string,
  next: { enabled: boolean; root: string | null; serverName: string },
): void {
  const config = readJson<PersistedConfig>(configPath) ?? {};
  config.codexPlusPlus ??= {};
  config.codexPlusPlus.selfTools = {
    enabled: next.enabled,
    ...(next.root ? { root: next.root } : {}),
    serverName: next.serverName,
    configuredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function resolveCodexConfigPath(path: string | undefined): string {
  return path ? resolve(path) : join(homedir(), ".codex", "config.toml");
}

function inferInstallerCli(root: string): string | null {
  const candidate = resolve(root, "packages", "installer", "dist", "cli.js");
  return existsSync(candidate) ? candidate : null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map(formatTomlString).join(", ")}]`;
}

function formatTomlInlineTable(record: Record<string, string>): string {
  return `{ ${Object.entries(record)
    .map(([key, value]) => `${formatTomlKey(key)} = ${formatTomlString(value)}`)
    .join(", ")} }`;
}

function formatTomlKey(key: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(key) ? key : formatTomlString(key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
