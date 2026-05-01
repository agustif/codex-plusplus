import assert from "node:assert/strict";
import test from "node:test";
import {
  SELF_MCP_MANAGED_END,
  SELF_MCP_MANAGED_START,
  formatSelfMcpBlock,
  mergeSelfMcpBlock,
  stripSelfMcpBlock,
} from "../src/commands/self-tools";

test("self tools MCP block exposes repo root and runtime server path", () => {
  const block = formatSelfMcpBlock({
    serverName: "codexpp-self",
    launcherPath: "/Users/af/Library/Application Support/codex-plusplus/runtime/self-mcp-launcher.js",
    serverPath: "/Users/af/Library/Application Support/codex-plusplus/runtime/self-mcp-server.js",
    root: "/Users/af/codex-plusplus",
    userRoot: "/Users/af/Library/Application Support/codex-plusplus",
    installerCli: "/Users/af/codex-plusplus/packages/installer/dist/cli.js",
  });

  assert.match(block, new RegExp(escapeRegExp(SELF_MCP_MANAGED_START)));
  assert.match(block, /\[mcp_servers\.codexpp-self\]/);
  assert.match(block, /command = "node"/);
  assert.match(block, /args = \["\/Users\/af\/Library\/Application Support\/codex-plusplus\/runtime\/self-mcp-launcher\.js"\]/);
  assert.match(block, /CODEXPP_SELF_WORKER = "\/Users\/af\/Library\/Application Support\/codex-plusplus\/runtime\/self-mcp-server\.js"/);
  assert.match(block, /CODEXPP_SELF_ROOT = "\/Users\/af\/codex-plusplus"/);
  assert.match(block, /CODEXPP_SELF_CLI = "\/Users\/af\/codex-plusplus\/packages\/installer\/dist\/cli\.js"/);
  assert.match(block, new RegExp(escapeRegExp(SELF_MCP_MANAGED_END)));
});

test("self tools MCP block merge preserves manual MCP config", () => {
  const current = `[mcp_servers.github]\ncommand = "github-mcp"\n`;
  const block = formatSelfMcpBlock({
    serverName: "codexpp-self",
    launcherPath: "/tmp/runtime/self-mcp-launcher.js",
    serverPath: "/tmp/runtime/self-mcp-server.js",
    root: "/repo",
    userRoot: "/home",
    installerCli: null,
  });

  const merged = mergeSelfMcpBlock(current, block);
  assert.match(merged, /\[mcp_servers\.github\]/);
  assert.match(merged, /\[mcp_servers\.codexpp-self\]/);
  assert.equal(stripSelfMcpBlock(merged).trim(), current.trim());
});

test("self tools MCP block replacement is idempotent", () => {
  const first = formatSelfMcpBlock({
    serverName: "codexpp-self",
    launcherPath: "/tmp/one-launcher.js",
    serverPath: "/tmp/one.js",
    root: "/repo",
    userRoot: "/home",
    installerCli: null,
  });
  const second = formatSelfMcpBlock({
    serverName: "codexpp-self",
    launcherPath: "/tmp/two-launcher.js",
    serverPath: "/tmp/two.js",
    root: "/repo",
    userRoot: "/home",
    installerCli: null,
  });

  const merged = mergeSelfMcpBlock(mergeSelfMcpBlock("", first), second);
  assert.doesNotMatch(merged, /one\.js/);
  assert.match(merged, /two\.js/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
