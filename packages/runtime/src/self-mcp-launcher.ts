import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const workerPath = resolve(
  process.env.CODEXPP_SELF_WORKER ?? join(dirname(process.argv[1] ?? __filename), "self-mcp-server.js"),
);

let worker: ChildProcessWithoutNullStreams | null = null;
let stopping = false;
let stdinEnded = false;
let clientBuffer = "";
let workerBuffer = "";
let initializeRequest: JsonRpcMessage | null = null;
let initializedNotifications: JsonRpcMessage[] = [];
let replayInitializeId: string | number | null = null;
let replayingInitialize = false;
const pendingClientLines: string[] = [];

function log(message: string): void {
  console.error(`[codexpp-self-launcher] ${message}`);
}

function startWorker(replayInitialization: boolean): void {
  if (!existsSync(workerPath)) {
    log(`worker bundle not found: ${workerPath}`);
    process.exit(1);
  }

  workerBuffer = "";
  const next = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      CODEXPP_SELF_LAUNCHER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  worker = next;
  next.stdout.on("data", (chunk: Buffer) => handleWorkerData(chunk));
  next.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  next.on("exit", (code, signal) => {
    worker = null;
    replayingInitialize = false;
    replayInitializeId = null;
    if (stopping || stdinEnded) {
      process.exit(code ?? (signal ? 1 : 0));
    }
    log(`worker exited (${signal ?? code ?? "unknown"}); respawning`);
    setTimeout(() => startWorker(true), 100).unref();
  });

  next.on("error", (error) => {
    log(`worker failed: ${error.message}`);
  });

  if (replayInitialization && initializeRequest) {
    replayingInitialize = true;
    replayInitializeId = `codexpp-reinit-${Date.now()}`;
    sendToWorker({ ...initializeRequest, id: replayInitializeId });
    return;
  }

  flushPendingClientLines();
}

function handleClientData(chunk: Buffer): void {
  clientBuffer += chunk.toString("utf8");
  let nextLine: string | null;
  while ((nextLine = shiftLine("client")) !== null) {
    handleClientLine(nextLine);
  }
}

function handleWorkerData(chunk: Buffer): void {
  workerBuffer += chunk.toString("utf8");
  let nextLine: string | null;
  while ((nextLine = shiftLine("worker")) !== null) {
    handleWorkerLine(nextLine);
  }
}

function shiftLine(source: "client" | "worker"): string | null {
  const buffer = source === "client" ? clientBuffer : workerBuffer;
  const index = buffer.indexOf("\n");
  if (index === -1) return null;
  const line = buffer.slice(0, index).replace(/\r$/, "");
  if (source === "client") clientBuffer = buffer.slice(index + 1);
  else workerBuffer = buffer.slice(index + 1);
  return line;
}

function handleClientLine(line: string): void {
  const message = parseMessage(line);
  if (message?.method === "initialize" && message.id !== undefined) {
    initializeRequest = cloneMessage(message);
  }
  if (message?.method === "notifications/initialized") {
    initializedNotifications = [cloneMessage(message)];
  }

  if (!worker || replayingInitialize) {
    pendingClientLines.push(line);
    return;
  }
  writeWorkerLine(line);
}

function handleWorkerLine(line: string): void {
  const message = parseMessage(line);
  if (replayingInitialize && replayInitializeId !== null && message?.id === replayInitializeId) {
    for (const notification of initializedNotifications) sendToWorker(notification);
    replayingInitialize = false;
    replayInitializeId = null;
    flushPendingClientLines();
    return;
  }
  process.stdout.write(`${line}\n`);
}

function flushPendingClientLines(): void {
  while (worker && !replayingInitialize && pendingClientLines.length > 0) {
    writeWorkerLine(pendingClientLines.shift()!);
  }
}

function writeWorkerLine(line: string): void {
  if (!worker || worker.stdin.destroyed || !worker.stdin.writable) {
    pendingClientLines.push(line);
    return;
  }
  worker.stdin.write(`${line}\n`);
}

function sendToWorker(message: JsonRpcMessage): void {
  writeWorkerLine(JSON.stringify(message));
}

function parseMessage(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    return null;
  }
}

function cloneMessage(message: JsonRpcMessage): JsonRpcMessage {
  return JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
}

function stop(signal: NodeJS.Signals): void {
  stopping = true;
  if (worker && !worker.killed) {
    worker.kill(signal);
  } else {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk: Buffer) => handleClientData(chunk));
process.stdin.on("end", () => {
  stdinEnded = true;
  stopping = true;
  worker?.stdin.end();
});

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

startWorker(false);
