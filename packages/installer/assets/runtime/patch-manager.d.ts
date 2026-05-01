export type PatchChannel = "stable" | "beta";
export interface PatchManagerStatus {
    checkedAt: string;
    currentChannel: PatchChannel | "unknown";
    currentUserRoot: string;
    channels: PatchChannelStatus[];
}
export interface PatchChannelStatus {
    channel: PatchChannel;
    label: string;
    current: boolean;
    userRoot: string;
    statePath: string;
    configPath: string;
    appRoot: string;
    appExists: boolean;
    stateExists: boolean;
    codexVersion: string | null;
    codexPlusPlusVersion: string | null;
    bundleId: string | null;
    watcher: string | null;
    watcherLabel: string;
    watcherLoaded: boolean | null;
    runtimePreloadPath: string;
    runtimePreloadExists: boolean;
    runtimePreloadBytes: number | null;
    runtimeUpdatedAt: string | null;
    autoUpdate: boolean;
    cdp: PatchCdpStatus;
    commands: PatchChannelCommands;
}
export interface PatchCdpStatus {
    enabled: boolean;
    configuredPort: number;
    expectedPort: number;
    activePort: number | null;
    active: boolean;
    drift: boolean;
    jsonListUrl: string | null;
    jsonVersionUrl: string | null;
}
export interface PatchChannelCommands {
    repair: string;
    reopenWithCdp: string;
    status: string;
    updateCodex: string;
}
interface PatchManagerOptions {
    userRoot: string;
    runtimeDir: string;
    activeCdpPort: number | null;
    appName?: string;
    now?: () => Date;
    homeDir?: string;
    platform?: NodeJS.Platform;
    probeCdp?: (port: number) => Promise<boolean>;
    commandSucceeds?: (command: string, args: string[]) => boolean;
}
export declare function getPatchManagerStatus(options: PatchManagerOptions): Promise<PatchManagerStatus>;
export {};
