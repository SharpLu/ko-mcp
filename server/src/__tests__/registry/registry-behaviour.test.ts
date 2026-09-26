import { describe, it, expect, vi } from 'vitest';

// Mock ONLY the transport. Spreading importActual keeps the module's real
// constants (KO_FETCH_TIMEOUT_MS) and classes (KoTimeoutError) in place: a
// factory that lists exports by hand silently yields `undefined` for any new
// one, which is how the ko-bastion#127 timeout constant first read as undefined
// inside filings.ts and made a declared upstream leg vanish from this gate.
vi.mock('../../ko-fetch.js', async () => ({
  ...(await vi.importActual<typeof import('../../ko-fetch.js')>('../../ko-fetch.js')),
  koFetch: vi.fn(),
}));
import { koFetch } from '../../ko-fetch.js';

import { TOOL_REGISTRY, TOOLS_BY_NAME, TRANSPORT_PARAMS } from '../../registry/tools.js';
import { PROBES, PROBE_VARIANTS, cannedResponse, registerAllTools, templateToRegExp } from './probes.js';

const mock = vi.mocked(koFetch);

/**
 * GATES (a) COMPLETENESS and (b) BEHAVIOUR -- blocking.
 *
 * (a) A tool the server registers but the registry does not declare has no
 *     declared upstream route, no declared plan and no param contract, so none
 *     of the other gates can see it. The reverse (declared but unregistered) is
 *     equally fatal: the gates would be policing a tool nobody can call.
 *
 * (b) The registry is only worth something if it describes what the code DOES.
 *     Every handler is invoked against a mocked transport and the real calls are
 *     compared with the declaration: undeclared call, undeclared param, or a
 *     declared leg that never happens, all fail here.
 */

interface Observed { path: string; params: string[]; transport: 'koFetch' | 'fetch' }

/** Run one tool's probe and record every upstream call it makes. */
async function observe(tool: string): Promise<Observed[]> {
  const calls: Observed[] = [];
  mock.mockReset();
  mock.mockImplementation(async (_cfg: unknown, path: string, params?: Record<string, unknown>) => {
    calls.push({
      path,
      params: Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k]) => k)
        .filter((k) => !TRANSPORT_PARAMS.includes(k)),
      transport: 'koFetch',
    });
    return cannedResponse(path) as never;
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      params: [...url.searchParams.keys()].filter((k) => !TRANSPORT_PARAMS.includes(k)),
      transport: 'fetch',
    });
    // 403 is what the free tier really gets here; it drives the fallback path.
    return { ok: false, status: 403, text: async () => '', json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  try {
    const handler = registerAllTools().get(tool)!.handler;
    // Rendering may throw on canned data; the transport calls are already recorded.
    // Variants take branches the main probe cannot (mutually exclusive legs).
    for (const args of [PROBES[tool], ...(PROBE_VARIANTS[tool] ?? [])]) {
      await handler(args).catch(() => undefined);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

describe('registry gate (a): tool completeness', () => {
  it('every registered tool is declared in the registry, and vice versa', () => {
    const registered = [...registerAllTools().keys()].sort();
    const declared = TOOL_REGISTRY.map((t) => t.tool).sort();
    expect(
      declared,
      'src/registry/tools.ts and the registered tool set disagree. A new tool needs a ' +
      'TOOL_REGISTRY entry (tool/file/inputs/plan/upstreamRoutes) and a probe in probes.ts.',
    ).toEqual(registered);
  });

  it('declares 24 tools, the number the deploy health gate asserts', () => {
    expect(TOOL_REGISTRY.length).toBe(24);
  });

  it('tool names are unique', () => {
    expect(TOOLS_BY_NAME.size).toBe(TOOL_REGISTRY.length);
  });

  it('every tool has a probe that covers every one of its inputs', () => {
    const gaps: string[] = [];
    for (const spec of TOOL_REGISTRY) {
      const probe = PROBES[spec.tool];
      if (!probe) { gaps.push(`${spec.tool}: no probe`); continue; }
      for (const input of spec.inputs) {
        if (!(input in probe)) gaps.push(`${spec.tool}: probe does not set input "${input}"`);
      }
    }
    expect(gaps, `An unexercised input is an unchecked param:\n${gaps.join('\n')}`).toEqual([]);
  });

  it('declared inputs are exactly the tool\'s zod schema keys', () => {
    const tools = registerAllTools();
    const drift: string[] = [];
    for (const spec of TOOL_REGISTRY) {
      const schemaKeys = Object.keys(tools.get(spec.tool)!.schema).sort();
      const declared = [...spec.inputs].sort();
      if (JSON.stringify(schemaKeys) !== JSON.stringify(declared)) {
        drift.push(`${spec.tool}: schema [${schemaKeys}] vs registry [${declared}]`);
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });
});

describe('registry gate (b): declaration matches behaviour', () => {
  // No beforeEach(() => mock.mockReset()) here: an arrow body returns the mock,
  // and vitest treats a hook's return value as a cleanup callback -- it would
  // CALL the mock with no arguments after every test. observe() resets it.

  for (const spec of TOOL_REGISTRY) {
    it(`${spec.tool}: every upstream call it makes is declared`, async () => {
      const calls = await observe(spec.tool);
      const undeclared = calls.filter(
        (c) => !spec.upstreamRoutes.some(
          (leg) => leg.transport === c.transport && templateToRegExp(leg.path).test(c.path),
        ),
      );
      expect(
        undeclared.map((c) => `${c.transport} ${c.path} (${c.params})`),
        `${spec.tool} called an upstream route that src/registry/tools.ts does not declare. ` +
        'Add the leg (path/method/params/transport/role) -- an undeclared leg is an unchecked ' +
        'route, param contract and plan.',
      ).toEqual([]);
    });

    it(`${spec.tool}: every declared leg actually happens`, async () => {
      const calls = await observe(spec.tool);
      const missing = spec.upstreamRoutes.filter(
        (leg) => !calls.some(
          (c) => c.transport === leg.transport && templateToRegExp(leg.path).test(c.path),
        ),
      );
      expect(
        missing.map((l) => `${l.transport} ${l.path} (${l.role})`),
        `${spec.tool} declares a leg the probe never triggered. Either the registry entry is ` +
        'stale or the probe does not reach it -- both make the gate blind.',
      ).toEqual([]);
    });

    it(`${spec.tool}: the params on the wire are exactly the declared ones`, async () => {
      const calls = await observe(spec.tool);
      const drift: string[] = [];
      for (const leg of spec.upstreamRoutes) {
        const call = calls.find(
          (c) => c.transport === leg.transport && templateToRegExp(leg.path).test(c.path),
        );
        if (!call) continue; // reported by the previous test
        const sent = [...call.params].sort();
        const declared = [...leg.params].sort();
        if (JSON.stringify(sent) !== JSON.stringify(declared)) {
          drift.push(`${leg.path}: wire [${sent}] vs registry [${declared}]`);
        }
      }
      expect(drift, `${spec.tool}\n${drift.join('\n')}`).toEqual([]);
    });
  }
});
