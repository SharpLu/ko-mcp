import { describe, it, expect } from 'vitest';
import {
  TOOL_REGISTRY, INERT_PARAMS, SILENT_TRUNCATIONS, TRANSPORT_PARAMS,
} from '../../registry/tools.js';
import {
  upstreamRoute, upstreamReadParams, freeBlockedPrefixes, UPSTREAM_CONTRACT,
  PAID_AUTH_MODES, UPSTREAM_PIN,
} from '../../registry/upstream.js';

/**
 * GATES (c) EXISTENCE, (d) PARAMS, (e) TRUNCATION, (f) PLAN -- blocking, all
 * against the SHA-pinned ko-api snapshot in src/registry/upstream/.
 *
 * These are the cross-repo half of the contract that never existed: ko-api's
 * registry declares what each route is, this asserts that what ko-mcp sends it
 * is something that route will actually honour.
 */

const route = (method: string, path: string) => upstreamRoute(method, path);

describe('the pinned contract is complete for this tool surface', () => {
  it('pins every route a tool declares, with its param reads', () => {
    const unpinned = TOOL_REGISTRY.flatMap((t) => t.upstreamRoutes)
      .filter((leg) => upstreamReadParams(leg.method, leg.path) === null)
      .map((leg) => `${leg.method} ${leg.path}`);
    expect(
      [...new Set(unpinned)],
      'Route declared by a tool but absent from the pinned contract. Add it to ' +
      'MCP_UPSTREAM_ROUTES (and its file to SCANNED_ROUTE_FILES) in ' +
      'scripts/upstream-pin-lib.mjs, then re-run registry:refresh-pin.',
    ).toEqual([]);
  });

  it('pins no route no tool calls (the contract is the MCP surface, not ko-api\'s)', () => {
    const declared = new Set(
      TOOL_REGISTRY.flatMap((t) => t.upstreamRoutes).map((l) => `${l.method} ${l.path}`),
    );
    const extra = Object.keys(UPSTREAM_CONTRACT.routes).filter((k) => !declared.has(k));
    expect(extra, `pinned but unused:\n${extra.join('\n')}`).toEqual([]);
  });

  it('carries the free-plan blocked prefixes', () => {
    const blocked = freeBlockedPrefixes();
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((p) => p.startsWith('/api/v1/'))).toBe(true);
  });
});

describe('registry gate (c): every tool route exists upstream', () => {
  it('no tool points at a route ko-api does not serve', () => {
    const phantom: string[] = [];
    for (const spec of TOOL_REGISTRY) {
      for (const leg of spec.upstreamRoutes) {
        if (!route(leg.method, leg.path)) phantom.push(`${spec.tool} -> ${leg.method} ${leg.path}`);
      }
    }
    expect(
      phantom,
      `Tool(s) declaring a ko-api route that is not in the pinned registry ` +
      `(ko-api ${UPSTREAM_PIN.commit.slice(0, 12)}). Either the path is wrong, or ko-api ` +
      `removed/renamed it and the pin needs refreshing:\n${phantom.join('\n')}`,
    ).toEqual([]);
  });

  it('cross-checks every declared leg (count is the coverage this gate has)', () => {
    const legs = TOOL_REGISTRY.flatMap((t) => t.upstreamRoutes);
    expect(legs.length).toBe(27);
    // 24 distinct ko-api paths. The M0 audit's headline said 20, but its own
    // per-tool matrix lists 24 -- the four EDGAR filing routes are the gap.
    expect(new Set(legs.map((l) => `${l.method} ${l.path}`)).size).toBe(24);
  });
});

describe('registry gate (d): no tool sends a param nobody reads', () => {
  const exceptionKey = (t: string, p: string, param: string) => `${t}|${p}|${param}`;
  const declaredExceptions = new Map(
    INERT_PARAMS.map((e) => [exceptionKey(e.tool, e.path, e.param), e]),
  );

  it('every param on the wire is read by that upstream handler, or is an annotated exception', () => {
    const unread: string[] = [];
    for (const spec of TOOL_REGISTRY) {
      for (const leg of spec.upstreamRoutes) {
        const read = upstreamReadParams(leg.method, leg.path) ?? [];
        for (const param of leg.params) {
          if (read.includes(param) || TRANSPORT_PARAMS.includes(param)) continue;
          if (declaredExceptions.has(exceptionKey(spec.tool, leg.path, param))) continue;
          unread.push(
            `${spec.tool} sends "${param}" to ${leg.path}, which reads only [${read.join(', ')}]`,
          );
        }
      }
    }
    expect(
      unread,
      'A param no upstream handler reads is dropped in silence: the caller is told a filter or ' +
      'a row count was applied and it was not. Fix the tool, or add an INERT_PARAMS entry naming ' +
      `its issue:\n${unread.join('\n')}`,
    ).toEqual([]);
  });

  it('every INERT_PARAMS entry is still a live defect (a fix must retire it)', () => {
    const stale: string[] = [];
    for (const e of INERT_PARAMS) {
      const read = upstreamReadParams('GET', e.path);
      if (read === null) { stale.push(`${e.tool}: ${e.path} is no longer scanned`); continue; }
      if (read.includes(e.param)) {
        stale.push(
          `${e.tool}: ${e.path} NOW READS "${e.param}" -- ${e.issue} looks fixed upstream. ` +
          'Delete this INERT_PARAMS entry (and check the tool sends a sane value).',
        );
      }
      const spec = TOOL_REGISTRY.find((t) => t.tool === e.tool);
      const leg = spec?.upstreamRoutes.find((l) => l.path === e.path);
      if (!leg) { stale.push(`${e.tool}: no declared leg for ${e.path}`); continue; }
      if (!leg.params.includes(e.param)) {
        stale.push(`${e.tool}: no longer sends "${e.param}" to ${e.path} -- retire the exception.`);
      }
    }
    expect(stale, `Stale exceptions:\n${stale.join('\n')}`).toEqual([]);
  });

  it('the exception table is the size it should be, and only shrinks', () => {
    expect(INERT_PARAMS.length).toBe(8);
    // Was 6 (the M0 audit's 4 rendered truncations + the 2 shared resolve.ts
    // legs). ko-bastion#126 retired the 4; what is left is resolve.ts's internal
    // candidate lookup, shared by the two tools that take a free-text name --
    // bandwidth, not a rendered truncation, and shrinking it would change which
    // institution a name resolves to. See its INERT_PARAMS entry.
    expect(INERT_PARAMS.filter((e) => e.param === 'limit').length).toBe(2);
    expect(INERT_PARAMS.filter((e) => e.issue === 'ko-bastion#126').map((e) => e.tool).sort())
      .toEqual(['get_crypto_holder', 'get_institution_holdings']);
    // Params the tool ADVERTISES as filters that upstream never reads.
    expect(INERT_PARAMS.filter((e) => e.issue === 'ko-bastion#125').length).toBe(6);
  });
});

describe('registry gate (e): paginated routes get a row count', () => {
  it('a tool calling a paginated route sends a row param that route reads', () => {
    const excused = new Set(SILENT_TRUNCATIONS.map((s) => `${s.tool}|${s.path}`));
    const inert = new Set(INERT_PARAMS.map((e) => `${e.tool}|${e.path}`));
    const silent: string[] = [];
    for (const spec of TOOL_REGISTRY) {
      for (const leg of spec.upstreamRoutes) {
        if (!route(leg.method, leg.path)?.pagination) continue;
        const read = upstreamReadParams(leg.method, leg.path) ?? [];
        const rowParams = ['per_page', 'limit'].filter((p) => read.includes(p));
        if (leg.params.some((p) => rowParams.includes(p))) continue;
        if (excused.has(`${spec.tool}|${leg.path}`)) continue;
        // Already reported by gate (d) as an inert row param on this route.
        if (inert.has(`${spec.tool}|${leg.path}`)) continue;
        silent.push(
          `${spec.tool} -> ${leg.path} is paginated upstream but the tool sends none of ` +
          `[${rowParams.join(', ')}]: it silently receives the upstream default.`,
        );
      }
    }
    expect(silent, silent.join('\n')).toEqual([]);
  });

  it('every SILENT_TRUNCATIONS entry is still a live defect', () => {
    const stale: string[] = [];
    for (const s of SILENT_TRUNCATIONS) {
      const spec = TOOL_REGISTRY.find((t) => t.tool === s.tool);
      const leg = spec?.upstreamRoutes.find((l) => l.path === s.path);
      if (!leg) { stale.push(`${s.tool}: no declared leg for ${s.path}`); continue; }
      const read = upstreamReadParams('GET', s.path) ?? [];
      const rowParams = ['per_page', 'limit'].filter((p) => read.includes(p));
      if (leg.params.some((p) => rowParams.includes(p))) {
        stale.push(`${s.tool} now sends a row count to ${s.path} -- retire this ${s.issue} entry.`);
      }
      if (!route('GET', s.path)?.pagination) {
        stale.push(`${s.path} is no longer paginated upstream -- retire this entry.`);
      }
    }
    expect(stale, `Stale exceptions:\n${stale.join('\n')}`).toEqual([]);
  });

  it('nothing is excused: every tool on a paginated route sends a row count', () => {
    // ko-bastion#126. The three days-window macro tools that used to be excused
    // here (get_ftd_data, get_economic_indicators, get_financial_stress) now
    // send page + per_page. An empty table means the gate above is enforcing the
    // rule with no carve-outs, which is the only state worth having.
    expect(SILENT_TRUNCATIONS.map((s) => s.tool)).toEqual([]);
  });
});

describe('registry gate (f): declared plan matches what ko-api enforces', () => {
  const blocked = freeBlockedPrefixes();
  /** What ko-api would do to a free/demo caller for this tool. */
  const derivePlan = (tool: (typeof TOOL_REGISTRY)[number]) => {
    const reasons: string[] = [];
    for (const leg of tool.upstreamRoutes) {
      const spec = route(leg.method, leg.path);
      if (!spec) continue;
      if (PAID_AUTH_MODES.includes(spec.auth)) reasons.push(`${leg.path} auth=${spec.auth}`);
      const prefix = blocked.find((p) => leg.path.startsWith(p));
      if (prefix) reasons.push(`${leg.path} blocked on free by ${prefix}`);
    }
    return { plan: reasons.length ? 'paid' : 'free', reasons };
  };

  it('no tool claims a plan the pinned registry contradicts', () => {
    const drift: string[] = [];
    for (const spec of TOOL_REGISTRY) {
      const { plan, reasons } = derivePlan(spec);
      if (plan !== spec.plan) {
        drift.push(
          `${spec.tool}: registry says ${spec.plan}, ko-api says ${plan}` +
          (reasons.length ? ` (${reasons.join('; ')})` : ''),
        );
      }
    }
    expect(
      drift,
      'A tool that claims free but is gated returns a 403 the model cannot distinguish from ' +
      `"no data"; one that claims paid but is not hides a working tool:\n${drift.join('\n')}`,
    ).toEqual([]);
  });

  it('exactly 5 tools are paid: 4 blocked on free/demo + 1 paid-auth', () => {
    const paid = TOOL_REGISTRY.filter((t) => t.plan === 'paid').map((t) => t.tool);
    expect(paid.length).toBe(5);
    const byPrefix = TOOL_REGISTRY.filter((t) =>
      t.upstreamRoutes.some((l) => blocked.some((p) => l.path.startsWith(p))));
    expect(byPrefix.map((t) => t.tool).sort()).toEqual(
      ['get_economic_indicators', 'get_fed_rates', 'get_financial_stress', 'get_treasury_yields'],
    );
    const byAuth = TOOL_REGISTRY.filter((t) =>
      t.upstreamRoutes.some((l) => PAID_AUTH_MODES.includes(route(l.method, l.path)?.auth ?? '')));
    expect(byAuth.map((t) => t.tool)).toEqual(['sec_get_filing_document']);
  });

  it('get_ftd_data is NOT gated, despite living under /api/v1/sec', () => {
    // Measured 2026-09-12: unauthenticated, treasury/fed/economic/stress return a
    // 403 plan gate while /sec/ftd returns data. The blocked prefixes are
    // /sec/13dg, /sec/form-d, /sec/buybacks -- not /sec.
    expect(blocked.some((p) => '/api/v1/sec/ftd'.startsWith(p))).toBe(false);
  });

  it('upstream auth modes across the tool surface are the three the audit measured', () => {
    const counts: Record<string, number> = {};
    for (const leg of TOOL_REGISTRY.flatMap((t) => t.upstreamRoutes)) {
      const auth = route(leg.method, leg.path)?.auth ?? 'MISSING';
      counts[auth] = (counts[auth] ?? 0) + 1;
    }
    expect(counts.MISSING ?? 0).toBe(0);
    expect(counts.apiKeyPaid).toBe(1);
    expect(counts.signedTokenOrApiKeyPaid).toBe(1);
    expect(counts.apiKey).toBe(25);
  });
});
