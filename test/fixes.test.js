// Fix-executor + space-scan tests — applyFix/scanSpace run against
// the real confluenceClient wired to a fake transport, proving the
// executor performs only additive writes, in the right order, and
// refuses safely when there is nothing to do.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as conf from '../src/lib/confluenceClient.js';
import { applyFix, scanSpace, FLAG_LABEL } from '../src/lib/fixes.js';
import { checkPage } from '../src/lib/decisionRules.js';

afterEach(() => conf.setTransportForTests(null));

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

const NO_DUEDATE = {
  'GET /rest/api/content/1001/property/rulebridge-duedate': {
    status: 404,
    json: { message: 'no property' },
  },
};

test('flag-page fix adds the needs-review label and touches no body', async () => {
  const calls = wire({
    'POST /rest/api/content/1001/label': { status: 200, json: {} },
  });
  const page = { id: '1001', title: 'Refund policy — FINAL', labels: ['policy'] };
  const result = await applyFix(conf, page, { kind: 'flag-page' });
  assert.equal(result.applied, true);
  assert.match(result.detail, /needs-review/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

test('flag-page fix reports when the label is already present', async () => {
  wire({});
  const page = { id: '1001', title: 'Refund policy — FINAL', labels: [FLAG_LABEL] };
  const result = await applyFix(conf, page, { kind: 'flag-page' });
  assert.equal(result.applied, false);
  assert.match(result.detail, /already carries/);
});

test('decision-log fix prepends a log block and preserves the body', async () => {
  const calls = wire({
    'GET /rest/api/content/1001': { status: 200, json: DECIDED_PAGE },
    'PUT /rest/api/content/1001': {
      status: 200,
      json: { id: '1001', version: { number: 4 } },
    },
  });
  const page = {
    id: '1001',
    title: 'Q3 pricing — DECIDED',
    statusSignal: 'decided',
    labels: ['decision'],
  };
  const finding = {
    rule: 'owner-without-due-date',
    fix: { kind: 'insert-decision-log', owner: 'Maya Chen', item: 'Maya Chen to confirm the discount ceiling' },
  };
  const result = await applyFix(conf, page, finding.fix, { finding });
  assert.equal(result.applied, true);
  assert.match(result.detail, /version 4/);
  const put = calls.find((c) => c.method === 'PUT');
  const newBody = put.body.body.storage.value;
  assert.ok(newBody.includes('RuleBridge decision log'));
  assert.ok(newBody.includes('Maya Chen'));
  // The original body survives intact below the inserted block.
  assert.ok(newBody.includes('We picked tiered pricing.'));
  assert.ok(newBody.indexOf('RuleBridge decision log') < newBody.indexOf('We picked tiered pricing.'));
});

test('draft-summary fix lists the page\'s current contradictions', async () => {
  const calls = wire({
    'GET /rest/api/content/1001': { status: 200, json: DECIDED_PAGE },
    'PUT /rest/api/content/1001': {
      status: 200,
      json: { id: '1001', version: { number: 4 } },
    },
  });
  const page = {
    id: '1001',
    title: 'Q3 pricing — DECIDED',
    statusSignal: 'decided',
    labels: ['decision'],
    bodyText:
      'We picked tiered pricing.\n- [ ] Maya Chen to confirm the discount ceiling',
    dueDate: null,
  };
  // Sanity: the engine really does flag this page.
  assert.equal(checkPage(page).consistent, false);
  const result = await applyFix(conf, page, { kind: 'draft-summary' });
  assert.equal(result.applied, true);
  assert.match(result.detail, /unresolved-items summary/);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.body.body.storage.value.includes('Unresolved contradictions on this page'));
});

test('unknown fix kinds throw rather than silently no-op', async () => {
  wire({});
  await assert.rejects(
    () => applyFix(conf, { id: '1001', labels: [] }, { kind: 'rewrite-body' }),
    /Unknown fix kind/,
  );
});

test('a fix without a kind throws', async () => {
  wire({});
  await assert.rejects(() => applyFix(conf, { id: '1001', labels: [] }, {}), /kind/);
});

test('scanSpace flags self-contradicting pages and skips clean ones', async () => {
  wire({
    'GET /rest/api/content/search': {
      status: 200,
      json: { results: [DECIDED_PAGE, CLEAN_PAGE], totalSize: 2, start: 0 },
    },
    ...NO_DUEDATE,
  });
  const result = await scanSpace(conf, 'TEAM');
  assert.equal(result.scanned, 2);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].page.id, '1001');
  assert.ok(result.flagged[0].findings.some((f) => f.rule === 'decided-but-open-actions'));
  assert.equal(result.pairs.length, 0);
});

test('scanSpace detects a contradicting pair via shared position subjects', async () => {
  const stanceFor = {
    ...CLEAN_PAGE,
    id: '1003',
    title: 'Platform decision',
    body: {
      storage: { value: '<p>Decision: use Postgres</p>', representation: 'storage' },
    },
  };
  const stanceAgainst = {
    ...CLEAN_PAGE,
    id: '1004',
    title: 'Data review',
    body: {
      storage: { value: '<p>Rejected: Postgres</p>', representation: 'storage' },
    },
  };
  wire({
    'GET /rest/api/content/search': {
      status: 200,
      json: { results: [stanceFor, stanceAgainst], totalSize: 2, start: 0 },
    },
  });
  const result = await scanSpace(conf, 'TEAM');
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].topic, 'postgres');
  assert.equal(result.pairs[0].findings[0].rule, 'contradictory-linked-decisions');
});
