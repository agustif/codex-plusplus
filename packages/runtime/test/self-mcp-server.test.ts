import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listFiles,
  readFileWindow,
  resolveInsideRoot,
  resolveSelfMcpConfig,
  searchCode,
  writeFileUnderRoot,
} from "../src/self-mcp-server";

test("self MCP config resolves CODEXPP_SELF_ROOT", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-self-root-"));
  try {
    const config = resolveSelfMcpConfig({ CODEXPP_SELF_ROOT: root, CODEXPP_SELF_HOME: "/tmp/home" });
    assert.equal(config.root, realpathSync(root));
    assert.equal(config.userRoot, "/tmp/home");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self MCP path resolver stays inside the configured root", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-self-path-"));
  try {
    assert.equal(resolveInsideRoot(root, "a/b.txt"), join(root, "a", "b.txt"));
    assert.throws(() => resolveInsideRoot(root, "../escape.txt"), /escapes self root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self MCP read and write operate on repo-relative files", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-self-rw-"));
  try {
    const result = writeFileUnderRoot(root, "src/example.txt", "hello world");
    assert.match(result, /src\/example\.txt/);
    assert.equal(readFileSync(join(root, "src", "example.txt"), "utf8"), "hello world");
    assert.match(readFileWindow(root, "src/example.txt", 6, 5), /world$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self MCP list files returns project files", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-self-list-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "one.ts"), "");
    writeFileSync(join(root, "two.md"), "");
    const listed = await listFiles(root, { maxFiles: 10 });
    assert.match(listed, /src\/one\.ts|two\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self MCP search finds matches inside the configured root", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-self-search-"));
  try {
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "runtime", "src", "self.ts"), "const marker = 'ouroboros';\n");
    const result = await searchCode(root, { query: "ouroboros", glob: "*.ts" });
    assert.match(result, /packages\/runtime\/src\/self\.ts:1:\d+:const marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
