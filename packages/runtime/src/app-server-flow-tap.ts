import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { appendCappedLog } from "./logging";

const DEFAULT_MAX_FLOW_LOG_BYTES = 25 * 1024 * 1024;
const MAX_LINE_CHARS = 200_000;
const MAX_BUFFERED_CHARS = 1_000_000;
const MAX_QUEUED_LOG_BYTES = 2 * 1024 * 1024;

type FlowTapSource = "env" | "config" | "off";
type FlowStreamName = "stdin" | "stdout" | "stderr";

export interface AppServerFlowTapConfig {
  enabled: boolean;
  logPath: string;
  maxBytes?: number;
  source?: FlowTapSource;
  rawPayloads?: boolean;
  now?: () => string;
}

export interface AppServerFlowTapRuntimeStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  source: FlowTapSource;
  logPath: string;
  activePids: number[];
  childCount: number;
  capturedMessages: number;
  lastEventAt: string | null;
  rawPayloads: boolean;
  droppedLogLines: number;
}

interface FlowTapState {
  installed: boolean;
  enabled: boolean;
  source: FlowTapSource;
  logPath: string;
  maxBytes: number;
  activePids: Set<number>;
  childCount: number;
  capturedMessages: number;
  lastEventAt: string | null;
  seq: number;
  now: () => string;
  buffers: Map<string, string>;
  pendingRequests: Map<string, string>;
  rawPayloads: boolean;
  writeQueue: string[];
  writeQueueBytes: number;
  writeScheduled: boolean;
  droppedLogLines: number;
}

interface JsonRpcSummary {
  kind: "request" | "notification" | "response" | "error" | "unknown";
  id?: string | number | null;
  method?: string;
  threadId?: string;
  turnId?: string;
  status?: string;
  errorMessage?: string;
  resultDataCount?: number;
  hasNextCursor?: boolean;
}

const state: FlowTapState = {
  installed: false,
  enabled: false,
  source: "off",
  logPath: "",
  maxBytes: DEFAULT_MAX_FLOW_LOG_BYTES,
  activePids: new Set(),
  childCount: 0,
  capturedMessages: 0,
  lastEventAt: null,
  seq: 0,
  now: () => new Date().toISOString(),
  buffers: new Map(),
  pendingRequests: new Map(),
  rawPayloads: false,
  writeQueue: [],
  writeQueueBytes: 0,
  writeScheduled: false,
  droppedLogLines: 0,
};

export function installAppServerFlowTap(config: AppServerFlowTapConfig): AppServerFlowTapRuntimeStatus {
  configureAppServerFlowTap(config);
  if (state.installed) return getAppServerFlowTapRuntimeStatus();

  patchChildProcessModule(require("node:child_process"));
  patchFutureChildProcessLoads();
  state.installed = true;
  writeFlowEvent({
    event: "tap-installed",
    enabled: state.enabled,
    source: state.source,
  });

  return getAppServerFlowTapRuntimeStatus();
}

export function configureAppServerFlowTap(config: AppServerFlowTapConfig): AppServerFlowTapRuntimeStatus {
  const wasEnabled = state.enabled;
  state.enabled = config.enabled === true;
  state.source = config.source ?? (state.enabled ? "config" : "off");
  state.logPath = config.logPath;
  state.maxBytes = config.maxBytes ?? DEFAULT_MAX_FLOW_LOG_BYTES;
  state.rawPayloads = config.rawPayloads === true;
  state.now = config.now ?? state.now;

  if (wasEnabled && !state.enabled) {
    clearBufferedProtocolState();
  }

  try {
    mkdirSync(dirname(state.logPath), { recursive: true });
  } catch {}

  writeFlowEvent({
    event: "tap-configured",
    enabled: state.enabled,
    source: state.source,
  });

  return getAppServerFlowTapRuntimeStatus();
}

export function getAppServerFlowTapRuntimeStatus(): AppServerFlowTapRuntimeStatus {
  return {
    installed: state.installed,
    enabled: state.enabled,
    active: state.enabled && state.activePids.size > 0,
    source: state.source,
    logPath: state.logPath,
    activePids: state.enabled ? [...state.activePids].sort((a, b) => a - b) : [],
    childCount: state.childCount,
    capturedMessages: state.capturedMessages,
    lastEventAt: state.lastEventAt,
    rawPayloads: state.rawPayloads,
    droppedLogLines: state.droppedLogLines,
  };
}

export function isCodexAppServerSpawn(command: unknown, args: unknown): boolean {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (!argv.includes("app-server")) return false;
  const cmd = typeof command === "string" ? command : "";
  const cmdBase = basename(cmd).toLowerCase();
  return cmdBase === "codex" || cmdBase === "codex.exe";
}

export function summarizeJsonRpcLine(line: string): JsonRpcSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const params = isRecord(parsed.params) ? parsed.params : null;
  const result = isRecord(parsed.result) ? parsed.result : null;
  const error = isRecord(parsed.error) ? parsed.error : null;
  const turn = isRecord(result?.turn) ? result.turn : null;
  const status = stringValue(params?.status) ?? stringValue(turn?.status);
  const method = stringValue(parsed.method);
  const resultData = Array.isArray(result?.data) ? result.data : null;

  let kind: JsonRpcSummary["kind"] = "unknown";
  if (method && parsed.id !== undefined) kind = "request";
  else if (method) kind = "notification";
  else if (error) kind = "error";
  else if (parsed.id !== undefined && parsed.result !== undefined) kind = "response";

  return {
    kind,
    ...(parsed.id !== undefined ? { id: scalarId(parsed.id) } : {}),
    ...(method ? { method } : {}),
    ...(firstString(params?.threadId, result?.threadId, turn?.threadId) ? {
      threadId: firstString(params?.threadId, result?.threadId, turn?.threadId)!,
    } : {}),
    ...(firstString(params?.turnId, result?.turnId, turn?.id) ? {
      turnId: firstString(params?.turnId, result?.turnId, turn?.id)!,
    } : {}),
    ...(status ? { status } : {}),
    ...(error ? { errorMessage: stringValue(error.message) ?? "unknown JSON-RPC error" } : {}),
    ...(resultData ? { resultDataCount: resultData.length } : {}),
    ...(typeof result?.nextCursor === "string" ? { hasNextCursor: result.nextCursor.length > 0 } : {}),
  };
}

function patchFutureChildProcessLoads(): void {
  const Module = require("node:module") as typeof import("node:module") & {
    _load?: (request: string, parent: unknown, isMain: boolean) => unknown;
    __codexppFlowTapModuleWrapped?: boolean;
  };
  if (Module.__codexppFlowTapModuleWrapped || typeof Module._load !== "function") return;

  const originalLoad = Module._load;
  Module._load = function codexPlusPlusFlowTapModuleLoad(
    request: string,
    parent: unknown,
    isMain: boolean,
  ) {
    const loaded = originalLoad.apply(this, [request, parent, isMain]);
    if (request === "child_process" || request === "node:child_process") {
      patchChildProcessModule(loaded);
    }
    return loaded;
  };
  Module.__codexppFlowTapModuleWrapped = true;
}

function patchChildProcessModule(loaded: unknown): void {
  if (!isRecord(loaded)) return;
  const target = loaded as Record<string, unknown> & { __codexppFlowTapWrapped?: boolean };
  if (target.__codexppFlowTapWrapped) return;

  const originalSpawn = target.spawn;
  if (typeof originalSpawn === "function") {
    target.spawn = function codexPlusPlusSpawnWrapper(this: unknown, command: unknown, ...callArgs: unknown[]) {
      const child = Reflect.apply(originalSpawn, this, [command, ...callArgs]) as ChildProcess;
      const args = Array.isArray(callArgs[0]) ? callArgs[0] : [];
      if (isCodexAppServerSpawn(command, args)) {
        attachToChild(child, String(command), args.map(String));
      }
      return child;
    };
  }

  const originalExecFile = target.execFile;
  if (typeof originalExecFile === "function") {
    target.execFile = function codexPlusPlusExecFileWrapper(this: unknown, command: unknown, ...callArgs: unknown[]) {
      const child = Reflect.apply(originalExecFile, this, [command, ...callArgs]) as ChildProcess;
      const args = Array.isArray(callArgs[0]) ? callArgs[0] : [];
      if (isCodexAppServerSpawn(command, args)) {
        attachToChild(child, String(command), args.map(String));
      }
      return child;
    };
  }

  target.__codexppFlowTapWrapped = true;
}

function attachToChild(child: ChildProcess, command: string, args: string[]): void {
  const tagged = child as ChildProcess & { __codexppFlowTapped?: boolean; __codexppFlowKey?: string };
  if (tagged.__codexppFlowTapped) return;

  const childKey = `${Date.now()}-${++state.childCount}`;
  tagged.__codexppFlowTapped = true;
  tagged.__codexppFlowKey = childKey;

  if (typeof child.pid === "number") state.activePids.add(child.pid);
  if (state.enabled) {
    writeFlowEvent({
      event: "app-server-spawn",
      childKey,
      pid: child.pid ?? null,
      command,
      args,
    });
  }

  tapReadable(child, childKey, "stdout");
  tapReadable(child, childKey, "stderr");
  tapWritable(child, childKey);

  child.once("exit", (code, signal) => {
    flushChildBuffers(childKey, child.pid ?? null);
    if (typeof child.pid === "number") state.activePids.delete(child.pid);
    if (state.enabled) {
      writeFlowEvent({
        event: "app-server-exit",
        childKey,
        pid: child.pid ?? null,
        code,
        signal,
      });
    }
  });
  child.once("error", (error) => {
    if (state.enabled) {
      writeFlowEvent({
        event: "app-server-error",
        childKey,
        pid: child.pid ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function tapReadable(child: ChildProcess, childKey: string, stream: Extract<FlowStreamName, "stdout" | "stderr">): void {
  const readable = child[stream] as unknown as {
    emit?: (event: string | symbol, ...args: unknown[]) => boolean;
    __codexppFlowTapEmitWrapped?: boolean;
  } | null;
  if (!readable || readable.__codexppFlowTapEmitWrapped || typeof readable.emit !== "function") return;

  const originalEmit = readable.emit;
  readable.emit = function codexPlusPlusReadableEmit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    let result = false;
    try {
      result = Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
    } finally {
      if (event === "data" && isCapturableChunk(args[0])) {
        captureChunk(childKey, child.pid ?? null, stream, args[0]);
      }
    }
    return result;
  };
  readable.__codexppFlowTapEmitWrapped = true;
}

function tapWritable(child: ChildProcess, childKey: string): void {
  const writable = child.stdin as unknown as {
    write?: (...args: unknown[]) => boolean;
    end?: (...args: unknown[]) => unknown;
    __codexppFlowTapWrapped?: boolean;
  } | null;
  if (!writable || writable.__codexppFlowTapWrapped || typeof writable.write !== "function") return;

  const originalWrite = writable.write;
  writable.write = function codexPlusPlusStdinWrite(this: unknown, ...args: unknown[]): boolean {
    if (isCapturableChunk(args[0])) captureChunk(childKey, child.pid ?? null, "stdin", args[0], args[1]);
    return Reflect.apply(originalWrite, this, args) as boolean;
  };

  if (typeof writable.end === "function") {
    const originalEnd = writable.end;
    writable.end = function codexPlusPlusStdinEnd(this: unknown, ...args: unknown[]): unknown {
      if (isCapturableChunk(args[0])) captureChunk(childKey, child.pid ?? null, "stdin", args[0], args[1]);
      return Reflect.apply(originalEnd, this, args);
    };
  }

  writable.__codexppFlowTapWrapped = true;
}

function captureChunk(
  childKey: string,
  pid: number | null,
  stream: FlowStreamName,
  chunk: unknown,
  encoding?: unknown,
): void {
  if (!state.enabled) return;
  const text = chunkToText(chunk, encoding);
  if (text.length === 0) return;

  const bufferKey = `${childKey}:${stream}`;
  const next = `${state.buffers.get(bufferKey) ?? ""}${text}`.replace(/\r\n/g, "\n");
  const lines = next.split("\n");
  const remainder = lines.pop() ?? "";

  for (const line of lines) emitLine(childKey, pid, stream, line);

  if (remainder.length > MAX_BUFFERED_CHARS) {
    state.buffers.set(bufferKey, remainder.slice(-MAX_BUFFERED_CHARS));
    writeFlowEvent({
      event: "line-buffer-truncated",
      childKey,
      pid,
      stream,
      keptChars: MAX_BUFFERED_CHARS,
    });
  } else {
    state.buffers.set(bufferKey, remainder);
  }
}

function emitLine(childKey: string, pid: number | null, stream: FlowStreamName, line: string): void {
  if (line.trim().length === 0) return;
  const summary = stream === "stderr" ? null : correlateJsonRpcSummary(childKey, stream, summarizeJsonRpcLine(line));
  const truncated = line.length > MAX_LINE_CHARS;
  state.capturedMessages += 1;
  writeFlowEvent({
    event: "line",
    childKey,
    pid,
    stream,
    direction: flowDirection(stream),
    bytes: Buffer.byteLength(line),
    truncated,
    rawPayloads: state.rawPayloads,
    ...(state.rawPayloads ? { text: truncated ? line.slice(0, MAX_LINE_CHARS) : line } : {}),
    ...(summary ? { jsonrpc: summary } : {}),
  });
}

function correlateJsonRpcSummary(
  childKey: string,
  stream: FlowStreamName,
  summary: JsonRpcSummary | null,
): JsonRpcSummary | null {
  if (!summary || summary.id === undefined || summary.id === null) return summary;
  const requestKey = `${childKey}:${String(summary.id)}`;

  if (stream === "stdin" && summary.kind === "request" && summary.method) {
    state.pendingRequests.set(requestKey, summary.method);
    prunePendingRequests();
    return summary;
  }

  if (stream === "stdout" && (summary.kind === "response" || summary.kind === "error")) {
    const method = state.pendingRequests.get(requestKey);
    state.pendingRequests.delete(requestKey);
    return method && !summary.method ? { ...summary, method } : summary;
  }

  return summary;
}

function prunePendingRequests(): void {
  while (state.pendingRequests.size > 2_000) {
    const oldest = state.pendingRequests.keys().next().value;
    if (oldest === undefined) return;
    state.pendingRequests.delete(oldest);
  }
}

function flushChildBuffers(childKey: string, pid: number | null): void {
  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    const key = `${childKey}:${stream}`;
    const remaining = state.buffers.get(key);
    if (state.enabled && remaining) emitLine(childKey, pid, stream, remaining);
    state.buffers.delete(key);
  }
}

function writeFlowEvent(payload: Record<string, unknown>): void {
  if (!state.logPath) return;
  const ts = state.now();
  state.lastEventAt = ts;
  enqueueFlowLogLine(`${JSON.stringify({ ts, seq: ++state.seq, ...payload })}\n`);
}

function enqueueFlowLogLine(line: string): void {
  const bytes = Buffer.byteLength(line);
  state.writeQueue.push(line);
  state.writeQueueBytes += bytes;
  while (state.writeQueueBytes > MAX_QUEUED_LOG_BYTES && state.writeQueue.length > 0) {
    const dropped = state.writeQueue.shift() ?? "";
    state.writeQueueBytes -= Buffer.byteLength(dropped);
    state.droppedLogLines += 1;
  }

  if (state.writeScheduled) return;
  state.writeScheduled = true;
  setImmediate(flushFlowLogQueue);
}

function flushFlowLogQueue(): void {
  state.writeScheduled = false;
  const batch = state.writeQueue.join("");
  state.writeQueue = [];
  state.writeQueueBytes = 0;
  if (!batch) return;

  try {
    appendCappedLog(state.logPath, batch, state.maxBytes);
  } catch {}

  if (state.writeQueue.length > 0 && !state.writeScheduled) {
    state.writeScheduled = true;
    setImmediate(flushFlowLogQueue);
  }
}

function chunkToText(chunk: unknown, encoding: unknown): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString(typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

function isCapturableChunk(chunk: unknown): chunk is string | Buffer | Uint8Array {
  return typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array;
}

function clearBufferedProtocolState(): void {
  state.buffers.clear();
  state.pendingRequests.clear();
}

function flowDirection(stream: FlowStreamName): string {
  if (stream === "stdin") return "electron-main->app-server";
  if (stream === "stdout") return "app-server->electron-main";
  return "app-server->stderr";
}

function scalarId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed) return parsed;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
