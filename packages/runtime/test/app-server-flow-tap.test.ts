import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installAppServerFlowTap,
  isCodexAppServerSpawn,
  summarizeJsonRpcLine,
} from "../src/app-server-flow-tap";

test("detects bundled codex app-server stdio child processes", () => {
  assert.equal(
    isCodexAppServerSpawn("/Applications/Codex.app/Contents/Resources/codex", [
      "app-server",
      "--listen",
      "stdio://",
    ]),
    true,
  );
  assert.equal(
    isCodexAppServerSpawn("/Applications/Codex.app/Contents/Resources/codex", [
      "login",
    ]),
    false,
  );
  assert.equal(
    isCodexAppServerSpawn("/usr/bin/python3", [
      "app-server",
      "--listen",
      "stdio://",
    ]),
    false,
  );
});

test("summarizes app-server JSON-RPC requests without losing ids", () => {
  const summary = summarizeJsonRpcLine(JSON.stringify({
    id: "31",
    method: "turn/interrupt",
    params: {
      threadId: "thr_123",
      turnId: "turn_456",
    },
  }));

  assert.deepEqual(summary, {
    kind: "request",
    id: "31",
    method: "turn/interrupt",
    threadId: "thr_123",
    turnId: "turn_456",
  });
});

test("summarizes turn completion notifications", () => {
  const summary = summarizeJsonRpcLine(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "thr_123",
      turnId: "turn_456",
      status: "interrupted",
    },
  }));

  assert.deepEqual(summary, {
    kind: "notification",
    method: "turn/completed",
    threadId: "thr_123",
    turnId: "turn_456",
    status: "interrupted",
  });
});

test("summarizes JSON-RPC errors", () => {
  const summary = summarizeJsonRpcLine(JSON.stringify({
    id: "31",
    error: {
      code: -32000,
      message: "thread not found: thr_123",
    },
  }));

  assert.deepEqual(summary, {
    kind: "error",
    id: "31",
    errorMessage: "thread not found: thr_123",
  });
});

test("summarizes paginated JSON-RPC list responses", () => {
  const summary = summarizeJsonRpcLine(JSON.stringify({
    id: "41",
    result: {
      data: [{ id: "a" }, { id: "b" }],
      nextCursor: "2026-05-01T00:00:00.000Z",
    },
  }));

  assert.deepEqual(summary, {
    kind: "response",
    id: "41",
    resultDataCount: 2,
    hasNextCursor: true,
  });
});

test("returns null for non-JSON lines", () => {
  assert.equal(summarizeJsonRpcLine("stderr: not json"), null);
});

test("flow tap observes stdout without stealing early app-server output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexpp-flow-tap-"));
  const codexPath = join(dir, "codex");
  const logPath = join(dir, "flow.jsonl");

  writeFileSync(
    codexPath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(JSON.stringify({ id: 'early', result: { data: [{ id: 'a' }], nextCursor: 'cursor' } }) + '\\n');",
      "setTimeout(() => process.exit(0), 25);",
    ].join("\n"),
  );
  chmodSync(codexPath, 0o755);

  installAppServerFlowTap({
    enabled: true,
    logPath,
    rawPayloads: false,
    now: () => "2026-05-01T00:00:00.000Z",
  });

  const { createRequire } = await import("node:module");
  const require = createRequire(`${process.cwd()}/package.json`);
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exitPromise = once(child, "exit");

  let stdout = "";
  await delay(50);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  const [exitCode] = await exitPromise;
  assert.equal(exitCode, 0);
  assert.match(stdout, /early/);

  const log = await waitForLog(logPath, "resultDataCount");
  assert.match(log, /"resultDataCount":1/);
  assert.match(log, /"rawPayloads":false/);
  assert.doesNotMatch(log, /"text":/);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(path: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8");
      if (text.includes(needle)) return text;
    } catch {}
    await delay(20);
  }
  return readFileSync(path, "utf8");
}
