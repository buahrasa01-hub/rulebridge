import { checkPage } from './lib/decisionRules.js';
import * as confluence from './lib/confluenceClient.js';
import { applyFix, scanSpace } from './lib/fixes.js';

// ---------------------------------------------------------------------------
// RuleBridge — Rovo action handlers
//
// These are the Forge functions behind the `action` modules declared
// in manifest.yml. The RuleBridge agent (rovo:agent) invokes them, and
// because they are plain actions, any other Rovo agent a customer
// builds can invoke them too — the same brain the byline item uses,
// exposed as reusable tools.
//
// VARIANT NOTE (see DEVPOST.md): this is the Rovo variant of
// RuleBridge. The primary entry is Business Teams with the byline item
// + space page; shipping this agent + actions in the same manifest is
// what makes the Best Agents bonus angle real instead of aspirational.
//
// Action functions receive (payload, context): inputs come from an LLM
// extraction, so every handler validates them and falls back to the
// deterministic context value where one exists. Handlers return plain
// JSON; the agent turns it into natural language.
//
// Actions run with the invoking user's context; the API client uses
// asUser(), so the user's Confluence permissions gate every read and
// write. The fix action re-runs the check at invocation time and only
// applies a fix the engine currently offers — never a stale one.
// ---------------------------------------------------------------------------

function resolvePageId(payload) {
  return (
    (payload && payload.pageId) ||
    (payload &&
      payload.context &&
      payload.context.confluence &&
      payload.context.confluence.pageId) ||
    null
  );
}

/**
 * action: check-page-contradictions (GET, read-only)
 * Input: pageId. Returns the engine verdict for one page.
 */
export async function checkPageContradictions(payload) {
  const pageId = resolvePageId(payload);
  if (!pageId) {
    return { ok: false, error: 'No page id was provided and none was found in the context.' };
  }
  const page = await confluence.getPage(pageId);
  const result = checkPage(page);
  return {
    ok: true,
    pageId: page.id,
    title: page.title,
    declaredState: page.statusSignal,
    consistent: result.consistent,
    verdict: result.verdict,
    findings: result.findings.map((f) => ({
      rule: f.rule,
      claim: f.claim,
      message: f.message,
      suggestedFix: f.fix ? f.fix.label : null,
    })),
  };
}

/**
 * action: fix-page-contradiction (UPDATE)
 * Inputs: pageId, fixKind ('insert-decision-log' | 'flag-page' |
 * 'draft-summary').
 *
 * The action re-runs the check first and applies the fix that matches
 * the requested kind from the *actual* findings — it never applies a
 * fix the engine did not offer for the page's current state, so a
 * stale or hallucinated request fails safely instead of writing.
 * ('draft-summary' is always available: it summarises whatever the
 * current findings are.)
 */
export async function fixPageContradiction(payload) {
  const pageId = resolvePageId(payload);
  const fixKind = payload && payload.fixKind;
  if (!pageId || !fixKind) {
    return { ok: false, error: 'Both pageId and fixKind are required.' };
  }
  const page = await confluence.getPage(pageId);
  if (fixKind === 'draft-summary') {
    const result = await applyFix(confluence, page, { kind: 'draft-summary' });
    return { ok: result.applied, pageId, ...result };
  }
  const check = checkPage(page);
  const finding = check.findings.find((f) => f.fix && f.fix.kind === fixKind);
  if (!finding) {
    return {
      ok: false,
      pageId,
      error: `No "${fixKind}" fix is currently offered for "${page.title}" (consistent: ${check.consistent}).`,
    };
  }
  const applied = await applyFix(confluence, page, finding.fix, { finding });
  return { ok: applied.applied, pageId, rule: finding.rule, ...applied };
}

/**
 * action: scan-space-contradictions (GET, read-only)
 * Input: spaceKey. Returns every self-contradicting page in the space
 * plus any contradicting linked pairs (Rule 6).
 */
export async function scanSpaceContradictions(payload) {
  const spaceKey =
    (payload && payload.spaceKey) ||
    (payload &&
      payload.context &&
      payload.context.confluence &&
      payload.context.confluence.spaceKey) ||
    null;
  if (!spaceKey) {
    return { ok: false, error: 'No space key was provided.' };
  }
  const result = await scanSpace(confluence, spaceKey);
  return {
    ok: true,
    spaceKey: result.spaceKey,
    scanned: result.scanned,
    flaggedCount: result.flagged.length,
    flagged: result.flagged.map((entry) => ({
      pageId: entry.page.id,
      title: entry.page.title,
      findings: entry.findings.map((f) => f.message),
    })),
    pairs: result.pairs.map((p) => ({
      topic: p.topic,
      verdict: p.verdict,
    })),
  };
}
