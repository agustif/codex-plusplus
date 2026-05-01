import { ipcRenderer } from "electron";

const CODEX_MESSAGE_FROM_VIEW = "codex_desktop:message-from-view";
const CODEX_MESSAGE_FOR_VIEW = "codex_desktop:message-for-view";
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

declare global {
  interface Window {
    electronBridge?: {
      sendMessageFromView?(message: unknown): Promise<void>;
    };
  }
}

export interface AppServerRequestOptions {
  hostId?: string;
  timeoutMs?: number;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

interface PendingRequest {
  id: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

let nextRequestId = 1;
const pendingRequests = new Map<string, PendingRequest>();
const notificationListeners = new Set<(notification: AppServerNotification) => void>();
let subscribed = false;

export function requestAppServer<T>(
  method: string,
  params: unknown,
  options: AppServerRequestOptions = {},
): Promise<T> {
  ensureSubscribed();
  const id = `codexpp-${Date.now()}-${nextRequestId++}`;
  const hostId = options.hostId ?? readHostId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timed out waiting for app-server response to ${method}`));
    }, timeoutMs);

    pendingRequests.set(id, {
      id,
      resolve: (value) => resolve(value as T),
      reject,
      timeout,
    });

    const message = {
      type: "mcp-request",
      hostId,
      request: { id, method, params },
    };

    sendMessageFromView(message).then((response) => {
      if (response !== undefined) handleIncomingMessage(response);
    }).catch((error) => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      pending.reject(toError(error));
    });
  });
}

export function onAppServerNotification(
  listener: (notification: AppServerNotification) => void,
): () => void {
  ensureSubscribed();
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}

export function readHostId(): string {
  try {
    const url = new URL(location.href);
    const hostId = url.searchParams.get("hostId")?.trim();
    return hostId || "local";
  } catch {
    return "local";
  }
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  ipcRenderer.on(CODEX_MESSAGE_FOR_VIEW, (_event, message) => {
    handleIncomingMessage(message);
  });
  window.addEventListener("message", (event) => {
    handleIncomingMessage(event.data);
  });
}

function handleIncomingMessage(message: unknown): void {
  const notification = extractNotification(message);
  if (notification) {
    for (const listener of notificationListeners) {
      try {
        listener(notification);
      } catch {
        /* isolate listener failures */
      }
    }
  }

  const response = extractResponse(message);
  if (!response) return;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingRequests.delete(response.id);
  if (response.error) {
    pending.reject(response.error);
    return;
  }
  pending.resolve(response.result);
}

function extractResponse(message: unknown): { id: string; result?: unknown; error?: Error } | null {
  if (!isRecord(message)) return null;

  if (message.type === "mcp-response" && isRecord(message.response)) {
    return responseFromEnvelope(message.response);
  }

  if (message.type === "mcp-response" && isRecord(message.message)) {
    return responseFromEnvelope(message.message);
  }

  if (message.type === "mcp-error" && typeof message.id === "string") {
    return { id: message.id, error: new Error(readErrorMessage(message.error) ?? "App-server request failed") };
  }

  if (message.type === "response" && typeof message.id === "string") {
    return responseFromEnvelope(message);
  }

  if (typeof message.id === "string" && ("result" in message || "error" in message)) {
    return responseFromEnvelope(message);
  }

  return null;
}

function responseFromEnvelope(envelope: Record<string, unknown>): { id: string; result?: unknown; error?: Error } | null {
  const id = typeof envelope.id === "string" || typeof envelope.id === "number"
    ? String(envelope.id)
    : null;
  if (!id) return null;

  if ("error" in envelope) {
    return { id, error: new Error(readErrorMessage(envelope.error) ?? "App-server request failed") };
  }

  return { id, result: envelope.result };
}

function extractNotification(message: unknown): AppServerNotification | null {
  if (!isRecord(message)) return null;

  if (message.type === "mcp-notification" && isRecord(message.request)) {
    const method = message.request.method;
    if (typeof method === "string") {
      return { method, params: message.request.params };
    }
  }

  if (message.type === "mcp-notification" && isRecord(message.message)) {
    const method = message.message.method;
    if (typeof method === "string") {
      return { method, params: message.message.params };
    }
  }

  if (message.type === "mcp-notification" && typeof message.method === "string") {
    return { method: message.method, params: message.params };
  }

  if (typeof message.method === "string" && !("id" in message)) {
    return { method: message.method, params: message.params };
  }

  return null;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    if (typeof error.error === "string") return error.error;
  }
  return null;
}

function sendMessageFromView(message: unknown): Promise<unknown> {
  const bridgeSender = window.electronBridge?.sendMessageFromView;
  if (typeof bridgeSender === "function") {
    return bridgeSender.call(window.electronBridge, message).then(() => undefined);
  }
  return ipcRenderer.invoke(CODEX_MESSAGE_FROM_VIEW, message);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
