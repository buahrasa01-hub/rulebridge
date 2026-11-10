import * as resolverModule from '@forge/resolver';

// Interop guard: @forge/resolver is a CommonJS package whose class lives
// on exports.default. Depending on how the Forge bundler wraps the module,
// the import binding can be the class itself, the exports object, or a
// namespace wrapping it — pick whichever level is the constructor.
// (Without this, the deployed bundle failed at load with
// "out_namespaceObject is not a constructor".)
const ResolverClass = [resolverModule, resolverModule?.default, resolverModule?.default?.default]
  .find((candidate) => typeof candidate === 'function');
import { checkPage } from '../lib/decisionRules.js';
import * as confluence from '../lib/confluenceClient.js';
import { applyFix, scanSpace } from '../lib/fixes.js';

// ---------------------------------------------------------------------------
// RuleBridge — backend resolvers
//
// One brain, two surfaces: the content byline item (per-page verdict)
// and the space page (whole-space scan) both end up calling the same
// engine (src/lib/decisionRules.js) and the same fix executor
// (src/lib/fixes.js) through the API seam in
// src/lib/confluenceClient.js.
//
// Reads and writes run asUser() (inside confluenceClient), so
// Confluence enforces the viewing user's permissions on everything
// the app does.
//
// Until the app is registered/deployed on a real site the resolvers
// cannot reach a live Confluence; analyzePage then answers from the
// demo fixture below and says so (source: 'fixture'), so the UI and
// the demo story stay honest before an account exists.
// ---------------------------------------------------------------------------

// Demo fixture: the classic silent contradiction — the title declares
// the decision made while the body still holds an open action and an
// unanswered question. Used ONLY as a fallback when the live read
// fails (pre-registration local runs); live reads are the norm.
const SAMPLE_PAGE = {
  id: 'demo-1',
  title: 'Q3 pricing — DECIDED',
  spaceKey: 'DEMO',
  status: 'current',
  statusSignal: 'decided',
  labels: ['decision'],
  bodyText: [
    'The team reviewed the three pricing options and picked tiered pricing.',
    '- [ ] Maya Chen to confirm the discount ceiling with Finance',
    'Open question: who owns the grandfathering exception for legacy plans?',
  ].join('\n'),
  dueDate: null,
};

const resolver = new ResolverClass();

function pageIdFrom(req) {
  return (
    (req.payload && req.payload.pageId) ||
    (req.context && req.context.extension && req.context.extension.content
      ? req.context.extension.content.id
      : null)
  );
}

// The byline item / content action asks: "does this page contradict
// the state it declares?" Answers with the normalised page, the full
// findings list and the engine verdict.
resolver.define('analyzePage', async (req) => {
  const pageId = pageIdFrom(req);
  if (!pageId) {
    return { source: 'fixture', page: SAMPLE_PAGE, ...checkPage(SAMPLE_PAGE) };
  }
  try {
    const page = await confluence.getPage(pageId);
    return { source: 'live', page, ...checkPage(page) };
  } catch (error) {
    // No live site yet (or a transient API failure): fall back to the
    // fixture and label it, rather than rendering a broken panel.
    console.warn(`analyzePage: live read failed for ${pageId}: ${error.message}`);
    return {
      source: 'fixture',
      page: { ...SAMPLE_PAGE, id: pageId },
      ...checkPage(SAMPLE_PAGE),
    };
  }
});

// Performs exactly one fix the human picked: { pageId, fix }.
// The fix descriptor comes from a finding produced by analyzePage
// (or is the standalone 'draft-summary'). Returns the executor's
// { applied, detail } result for display.
resolver.define('applyFix', async (req) => {
  const { pageId, fix } = req.payload || {};
  if (!pageId || !fix) {
    return { applied: false, detail: 'Missing pageId or fix in the request.' };
  }
  try {
    const page = await confluence.getPage(pageId);
    const finding = (checkPage(page).findings || []).find(
      (f) => f.fix && f.fix.kind === fix.kind,
    );
    return await applyFix(confluence, page, fix, { finding });
  } catch (error) {
    return { applied: false, detail: `Fix failed: ${error.message}` };
  }
});

// The space page asks for every contradicting page in the space.
// Bounded by the client's search cap; includes Rule 6 pair hits.
resolver.define('scanSpace', async (req) => {
  const spaceKey =
    (req.payload && req.payload.spaceKey) ||
    (req.context && req.context.extension && req.context.extension.space
      ? req.context.extension.space.key
      : null);
  if (!spaceKey) {
    return {
      spaceKey: null,
      scanned: 0,
      flagged: [],
      pairs: [],
      detail: 'No space key in context.',
    };
  }
  const result = await scanSpace(confluence, spaceKey);
  return {
    ...result,
    detail:
      `Scanned ${result.scanned} pages in ${spaceKey}; ` +
      `${result.flagged.length} page(s) contradict themselves and ` +
      `${result.pairs.length} contradicting pair(s) found.`,
  };
});

export const handler = resolver.getDefinitions();
