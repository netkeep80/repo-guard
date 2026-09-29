export type ImmutableSnapshotFormat = "json" | "yaml";
export interface ImmutableSnapshotIdentity {
    repository: string;
    sha: string;
}
export interface ImmutableSnapshotCacheMetrics {
    rawReads: number;
    rawHits: number;
    parses: number;
    parseHits: number;
}
export interface ImmutableSnapshotDocumentCache {
    read(identity: ImmutableSnapshotIdentity, path: string): unknown;
    parsed(identity: ImmutableSnapshotIdentity, path: string, format: ImmutableSnapshotFormat): unknown;
    metrics(): ImmutableSnapshotCacheMetrics;
}
type SnapshotParser = (content: string) => unknown;
export interface ImmutableSnapshotDocumentCacheOptions {
    readFileAtRef: (sha: string, path: string) => unknown;
    parsers: Record<ImmutableSnapshotFormat, SnapshotParser>;
}
export declare function createImmutableSnapshotDocumentCache(options: ImmutableSnapshotDocumentCacheOptions): ImmutableSnapshotDocumentCache;
export {};
