export interface H3Fixture {
  baseUrl: string;
  facts: {
    uploads: number;
    submissions: number;
    downloads: number;
    statusQueries: number;
    healthChecks: number;
    models: number;
    keys: string[];
    requests: Array<Record<string, unknown>>;
  };
  mode: {
    offline: boolean;
    uncertain: boolean;
    uploadHashMismatch: boolean;
    downloadInterrupted: boolean;
    hold: boolean;
  };
  video: Uint8Array;
  png: Uint8Array;
  close(): Promise<void>;
}
export function startH3Fixture(): Promise<H3Fixture>;
