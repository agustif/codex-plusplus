import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface SelfMcpConfig {
    root: string;
    userRoot: string | null;
    installerCli: string | null;
}
export declare function resolveSelfMcpConfig(env?: NodeJS.ProcessEnv): SelfMcpConfig;
export declare function createSelfMcpServer(config: SelfMcpConfig): McpServer;
export declare function resolveInsideRoot(root: string, path: string): string;
export declare function statusReport(config: SelfMcpConfig): Promise<string>;
export declare function listFiles(root: string, opts?: {
    pattern?: string;
    includeIgnored?: boolean;
    maxFiles?: number;
}): Promise<string>;
export declare function readFileWindow(root: string, path: string, offset?: number, maxBytes?: number): string;
export declare function searchCode(root: string, opts: {
    query: string;
    glob?: string;
    path?: string;
    includeIgnored?: boolean;
    context?: number;
    maxOutputBytes?: number;
}): Promise<string>;
export declare function writeFileUnderRoot(root: string, path: string, content: string, append?: boolean): string;
export declare function gitApply(root: string, patch: string, check?: boolean, reverse?: boolean): Promise<string>;
export declare function runtimeApply(config: SelfMcpConfig, opts: {
    channel?: "auto" | "stable" | "beta" | "both";
    restart?: boolean;
    build?: boolean;
    buildAll?: boolean;
    restartSelfMcp?: boolean;
}): Promise<string>;
export declare function runShell(root: string, command: string, timeoutMs?: number, maxOutputBytes?: number): Promise<string>;
