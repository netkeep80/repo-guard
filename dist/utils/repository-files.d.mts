export interface RepositoryFileOptions {
    repoRoot?: string;
    readFile?: (filePath: string) => unknown;
}
export declare function readRepositoryTextFile(filePath: string, options?: RepositoryFileOptions): string;
export declare function readRepositoryBufferFile(filePath: string, options?: RepositoryFileOptions): Buffer | null;
