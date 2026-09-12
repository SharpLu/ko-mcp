/**
 * Vite/vitest `?raw` imports. Used by src/registry/upstream.ts to read the
 * pinned ko-api contract as text WITHOUT node:fs -- this package has no
 * @types/node (the Worker has no filesystem), and the gates must hash the exact
 * bytes they parse, not a re-serialised copy of them.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
