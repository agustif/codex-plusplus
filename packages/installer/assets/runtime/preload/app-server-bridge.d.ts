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
export declare function requestAppServer<T>(method: string, params: unknown, options?: AppServerRequestOptions): Promise<T>;
export declare function onAppServerNotification(listener: (notification: AppServerNotification) => void): () => void;
export declare function readHostId(): string;
