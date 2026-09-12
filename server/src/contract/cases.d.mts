import type { KnownDefect } from './skeleton.d.mts';

export interface ManifestCase {
  name: string;
  arguments: Record<string, unknown>;
  why: string;
  recordedAs?: string;
  knownDefect?: KnownDefect;
}

export interface ManifestTool {
  tool: string;
  planGated?: boolean;
  cases: ManifestCase[];
}

export const NO_SUCH_TICKER: string;
export const APPLE_CIK: string;
export const APPLE_10K: string;
export const BERKSHIRE_CIK: string;
export const BREVAN_HOWARD_CIK: string;
export const EXCLUDED: Record<string, string>;
export const CASES: ManifestTool[];
export const PLAN_GATED_TOOLS: string[];
export const TOOLS: string[];
export const CASE_COUNT: number;
