// MCP-tool tests — the three Rovo action handlers behind the
// `rovo:mcp` module (check-page-contradictions,
// fix-page-contradiction, scan-space-contradictions) run against the
// real confluenceClient wired to a fake transport, exactly like the
// rest of the suite: no Atlassian site, no credentials, no live MCP
// connection. This proves the tools the MCP server exposes behave as
// their manifest descriptions promise — verdicts for checks, additive
// fixes only, and safe refusal for fixes that are not offered.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as conf from '../src/lib/confluenceClient.js';
import * as graph from '../src/lib/teamworkGraph.js';
import {
  checkPageContradictions,
  fixPageContradiction,
  scanSpaceContradictions,
} from '../src/rovo.js';

afterEach(() => {
  conf.setTransportForTests(null);
  graph.setTransportForTests(null);
});

const DECIDED_PAGE = {
  id: '1001',
  title: 'Q3 pricing — DECIDED',
  status: 'current',
  space: { key: 'TEAM' },
  version: { number: 3 },
  metadata: { labels: { results: [{ name: 'decision' }] } },
  body: {
    storage: {
      value:
        '<p>We picked tiered pricing.</p>' +
        '<ac:task><ac:task-status>incomplete</ac:task-status>' +
        '<ac:task-body>Maya Chen to confirm the discount ceiling</ac:task-body></ac:task>',
      representation: 'storage',
    },
  },
};

const CLEAN_PAGE = {
  id: '1002',
  title: 'Onboarding checklist',
  status: 'current',
  space: { key: 'TEAM' },
  version: { number: 1 },
  metadata: { labels: { results: [] } },
  body: {
    storage: {
      value: '<p>Welcome. Complete the steps in order.</p>',
      representation: 'storage',
    },
  },
};

// Title says FINAL, label says draft: Rule 5 (draft-labeled-final)
// offers the flag-page fix.
const FINAL_DRAFT_PAGE = {
  id: '1003',
  title: 'Refund policy — FINAL',
  status: 'current',
  space: { key: 'TEAM' },
  version: { number: 1 },
  metadata: { labels: { results: [{ name: 'draft' }] } },
  body: {
    storage: {
      value: '<p>Refunds are processed within 14 days.</p>',
      representation: 'storage',
    },
  },
};

function wire(routes) {
  const calls = [];
  conf.setTransportForTests(async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [prefix, answer] of Object.entries(routes)) {
      const [m, p] = prefix.split(' ');
      if (method === m && path.startsWith(p)) {
        return typeof answer === 'function' ? answer(body) : answer;
      }
    }
    return { status: 404, json: { message: `no route ${method} ${path}` } };
  });
  return calls;
}

// getPage() also reads the page-level due-date property; absent here.
const noDueDate = (id) => ({
  [`GET /rest/api/content/${id}/property/rulebridge-duedate`]: {
    status: 404,
    json: { message: 'no property' },
  },
});

test('MCP check-page-contradictions reports contradictions with the offered fix', async () => {
  wire({
    'GET /rest/api/content/1001?expand=': { status: 200, json: DECIDED_PAGE },
    ...noDueDate('1001'),
  });
  const result = await checkPageContradictions({ pageId: '1001' });
  assert.equal(result.ok, true);
  assert.equal(result.pageId, '1001');
  assert.equal(result.title, 'Q3 pricing — DECIDED');
  assert.equal(result.declaredState, 'decided');
  assert.equal(result.consistent, false);
  assert.ok(result.findings.some((f) => f.rule === 'decided-but-open-actions'));
  assert.ok(result.findings.every((f) => typeof f.suggestedFix === 'string'));
});

test('MCP check-page-contradictions falls back to the page id in context', async () => {
  wire({
    'GET /rest/api/content/1001?expand=': { status: 200, json: DECIDED_PAGE },
    ...noDueDate('1001'),
  });
  const result = await checkPageContradictions({
    context: { confluence: { pageId: '1001' } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pageId, '1001');
  assert.equal(result.consistent, false);
});

test('MCP check-page-contradictions fails safely with no page id', async () => {
  wire({});
  const result = await checkPageContradictions({});
  assert.equal(result.ok, false);
  assert.match(result.error, /page id/i);
});

test('MCP fix-page-contradiction applies the offered flag-page fix', async () => {
  const calls = wire({
    'GET /rest/api/content/1003?expand=': { status: 200, json: FINAL_DRAFT_PAGE },
    ...noDueDate('1003'),
    'POST /rest/api/content/1003/label': { status: 200, json: {} },
  });
  const result = await fixPageContradiction({ pageId: '1003', fixKind: 'flag-page' });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.rule, 'draft-labeled-final');
  assert.match(result.detail, /needs-review/);
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, [{ prefix: 'global', name: 'needs-review' }]);
  // The flag fix touches no body text: exactly one call, the label.
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('MCP fix-page-contradiction drafts the unresolved-items summary', async () => {
  const calls = wire({
    'GET /rest/api/content/1001?expand=': { status: 200, json: DECIDED_PAGE },
    ...noDueDate('1001'),
    'PUT /rest/api/content/1001': {
      status: 200,
      json: { id: '1001', version: { number: 4 } },
    },
  });
  const result = await fixPageContradiction({ pageId: '1001', fixKind: 'draft-summary' });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.match(result.detail, /unresolved-items summary/);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.body.body.storage.value.includes('Unresolved contradictions on this page'));
  // Additive only: the original body survives below the inserted block.
  assert.ok(put.body.body.storage.value.includes('We picked tiered pricing.'));
});

test('MCP fix-page-contradiction refuses a fix the check does not offer', async () => {
  wire({
    'GET /rest/api/content/1002?expand=': { status: 200, json: CLEAN_PAGE },
    ...noDueDate('1002'),
  });
  const result = await fixPageContradiction({ pageId: '1002', fixKind: 'insert-decision-log' });
  assert.equal(result.ok, false);
  assert.match(result.error, /No "insert-decision-log" fix is currently offered/);
});

// Locally clean page that states a position ("Decision: use
// Postgres") the graph-linked page contradicts ("Rejected:
// Postgres") — the only flag-page fix on offer comes from the graph
// (Rule 6 over real links), never from the page-local rules.
const GRAPH_ONLY_PAGE = {
  id: '100',
  title: 'Storage backend — DECIDED',
  status: 'current',
  space: { key: 'TEAM' },
  version: { number: 2 },
  metadata: { labels: { results: [{ name: 'decision' }] } },
  body: {
    storage: {
      value:
        '<p>Decision: use Postgres</p>' +
        '<p>The team picked Postgres for the new store.</p>',
      representation: 'storage',
    },
  },
};

const GRAPH_DATA = {
  confluencePageLinkedConfluencePages: {
    edges: [
      {
        node: {
          id: 'ari:cloud:confluence:cloud-1:page/200',
          pageId: '200',
          title: 'Storage backend — DECIDED',
          space: { key: 'TEAM' },
          content: {
            storage: {
              value:
                '<p>Decision log, updated after the migration review.</p>' +
                '<p>Rejected: Postgres</p>' +
                '<p>We will not use Postgres for the new store.</p>',
            },
          },
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

test('MCP fix-page-contradiction applies a graph-only flag-page fix', async () => {
  const calls = wire({
    'GET /rest/api/content/100?expand=': { status: 200, json: GRAPH_ONLY_PAGE },
    ...noDueDate('100'),
    'POST /rest/api/content/100/label': { status: 200, json: {} },
  });
  graph.setTransportForTests(async () => ({ data: GRAPH_DATA }));
  const result = await fixPageContradiction(
    { pageId: '100', fixKind: 'flag-page' },
    { cloudId: 'cloud-1' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.rule, 'contradictory-linked-decisions');
  assert.match(result.detail, /needs-review/);
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, [{ prefix: 'global', name: 'needs-review' }]);
});

test('MCP fix-page-contradiction refuses a graph-only fix when the graph is unreachable', async () => {
  wire({
    'GET /rest/api/content/100?expand=': { status: 200, json: GRAPH_ONLY_PAGE },
    ...noDueDate('100'),
  });
  // No cloudId in context: the graph returns unavailable without a
  // request, so the page-local check (clean) offers no flag-page fix.
  const result = await fixPageContradiction({ pageId: '100', fixKind: 'flag-page' });
  assert.equal(result.ok, false);
  assert.match(result.error, /No "flag-page" fix is currently offered/);
});

test('MCP scan-space-contradictions flags only the contradicting pages', async () => {
  wire({
    'GET /rest/api/content/search': {
      status: 200,
      json: { results: [DECIDED_PAGE, CLEAN_PAGE], totalSize: 2, start: 0 },
    },
  });
  const result = await scanSpaceContradictions({ spaceKey: 'TEAM' });
  assert.equal(result.ok, true);
  assert.equal(result.spaceKey, 'TEAM');
  assert.equal(result.scanned, 2);
  assert.equal(result.flaggedCount, 1);
  assert.equal(result.flagged[0].pageId, '1001');
  assert.ok(result.flagged[0].findings.some((m) => /action item/.test(m)));
  assert.deepEqual(result.pairs, []);
});

test('MCP scan-space-contradictions fails safely with no space key', async () => {
  wire({});
  const result = await scanSpaceContradictions({});
  assert.equal(result.ok, false);
  assert.match(result.error, /space key/i);
});
