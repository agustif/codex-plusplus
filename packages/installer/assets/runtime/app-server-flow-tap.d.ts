type FlowTapSource = "env" | "config" | "off";
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
export declare function installAppServerFlowTap(config: AppServerFlowTapConfig): AppServerFlowTapRuntimeStatus;
export declare function configureAppServerFlowTap(config: AppServerFlowTapConfig): AppServerFlowTapRuntimeStatus;
export declare function getAppServerFlowTapRuntimeStatus(): AppServerFlowTapRuntimeStatus;
export declare function isCodexAppServerSpawn(command: unknown, args: unknown): boolean;
export declare function summarizeJsonRpcLine(line: string): JsonRpcSummary | null;
export {};
