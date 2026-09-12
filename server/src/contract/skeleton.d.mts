export type Shape = string | { _array: Shape | null } | { [k: string]: Shape };

export interface TableMeta {
  columns: string[];
  /** Deliberately NOT part of the contract -- row count is data. */
  dataRows: number;
}

export interface TextSkeleton {
  lines: string[];
  tables: TableMeta[];
  verbatim?: boolean;
}

export interface ResponseContract {
  envelope: Shape;
  isError: boolean;
  contentTypes: string[];
  blocks: TextSkeleton[];
}

export type DefectProbe =
  | { kind: 'dataRowCount'; equals: number }
  | { kind: 'identicalToCase'; case: string }
  | { kind: 'headerWithoutRows' };

export interface KnownDefect {
  issue: string;
  summary: string;
  probe: DefectProbe;
}

export interface GoldenCase {
  name: string;
  arguments: Record<string, unknown>;
  why: string;
  contract: ResponseContract;
  /** Set when the pinned body came from a differently-named recording. */
  recordedAs?: string;
  knownDefect?: KnownDefect;
}

export interface GoldenFixture {
  tool: string;
  planGated: boolean;
  capturedAt: string;
  provenance: { source: string; mode: 'recordings' | 'build'; note: string };
  cases: GoldenCase[];
}

export interface GateResult {
  tools: number;
  checked: number;
  failures: Array<{ tool: string; case: string; problems: string[] }>;
  unreachable: Array<{ tool: string; case: string; err: string }>;
  defectsFixed: Array<{ tool: string; case: string; issue: string; why: string }>;
  defectsPresent: Array<{ tool: string; case: string; issue: string }>;
}

export const NULLABLE: 'null';
export function shapeOf(value: unknown): Shape;
export function diffShape(expected: Shape, actual: Shape, path?: string): string[];
export function normalizeLine(line: string): string;
export function rawValuesIn(line: string): string[];
export function textSkeleton(text: unknown): TextSkeleton;
export function contractOf(rpc: unknown): ResponseContract;
export function diffContract(pinned: ResponseContract, live: ResponseContract): string[];
export function checkDefect(
  probe: DefectProbe,
  caseName: string,
  live: ResponseContract,
  texts: Record<string, string>,
): string | null;
export function goldenDir(): string;
export function loadFixtures(dir: string): Promise<GoldenFixture[]>;
export function assertLoopback(base: string): void;
export function callTool(
  base: string,
  tool: string,
  args: unknown,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; err: string }>;
export function firstText(rpc: unknown): string;
export function runGoldenGate(
  fixtures: GoldenFixture[],
  opts: { base: string; fetchImpl?: typeof fetch },
): Promise<GateResult>;
