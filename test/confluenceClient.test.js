// confluenceClient tests — the client logic runs against an injected
// fake transport, so the REST paths, payloads and normalisation are
// verified with no Atlassian site and no credentials.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as conf from '../src/lib/confluenceClient.js';

afterEach(() => conf.setTransportForTests(null));

// A fake transport that records calls and answers from a route table.
// Routes map "METHOD path-prefix" -> { status, json } (or a function).
function fakeTransport(routes) {
  const calls = [];
  const transport = async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [prefix, answer] of Object.entries(routes)) {
      const [m, p] = prefix.split(' ');
      if (method === m && path.startsWith(p)) {
        return typeof answer === 'function' ? answer(body) : answer;
      }
    }
    return { status: 404, json: { message: `no route for ${method} ${path}` } };
  };
  return { transport, calls };
}

const RAW_PAGE = {
  id: '1001',
  title: 'Q3 pricing — DECIDED',
  status: 'current',
  space: { key: 'TEAM' },
  version: { number: 3 },
  metadata: { labels: { results: [{ name: 'Decision' }, { name: 'pricing' }] } },
  body: {
    storage: {
      value:
        '<p>We picked tiered pricing.</p>' +
        '<ac:task><ac:task-status>incomplete</ac:task-status>' +
        '<ac:task-body>Maya Chen to confirm the discount ceiling</ac:task-body></ac:task>' +
        '<p>Open question: who owns the grandfathering exception?</p>',
      representation: 'storage',
    },
  },
};

test('getPage normalises the REST payload for the engine', async () => {
  const { transport, calls } = fakeTransport({
    'GET /rest/api/content/1001': { status: 200, json: RAW_PAGE },
    'GET /rest/api/content/1001/property/rulebridge-duedate': {
      status: 404,
      json: { message: 'no property' },
    },
  });
  conf.setTransportForTests(transport);
  const page = await conf.getPage('1001');
  assert.equal(page.id, '1001');
  assert.equal(page.title, 'Q3 pricing — DECIDED');
  assert.equal(page.spaceKey, 'TEAM');
  assert.equal(page.statusSignal, 'decided');
  assert.deepEqual(page.labels, ['decision', 'pricing']);
  assert.match(page.bodyText, /- \[ \] Maya Chen to confirm the discount ceiling/);
  assert.equal(page.dueDate, null); // missing property degrades to null
  assert.equal(calls[0].method, 'GET');
});

test('getPage surfaces a stored due-date property', async () => {
  const { transport } = fakeTransport({
    'GET /rest/api/content/1001/property/rulebridge-duedate': {
      status: 200,
      json: { value: '2026-12-01' },
    },
    'GET /rest/api/content/1001': { status: 200, json: RAW_PAGE },
  });
  conf.setTransportForTests(transport);
  const page = await conf.getPage('1001');
  assert.equal(page.dueDate, '2026-12-01');
});

test('storageToText renders tasks with checkbox state and decodes entities', () => {
  const storage =
    '<h2>Notes</h2>' +
    '<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Book the room</ac:task-body></ac:task>' +
    '<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Send invites</ac:task-body></ac:task>' +
    '<p>Fish &amp; chips &lt;today&gt;</p>';
  const text = conf.storageToText(storage);
  assert.match(text, /- \[x\] Book the room/);
  assert.match(text, /- \[ \] Send invites/);
  assert.match(text, /Fish & chips <today>/);
  assert.equal(conf.storageToText(''), '');
  assert.equal(conf.storageToText(null), '');
});

test('detectStatusSignal prefers the settled claim over a stale draft label', () => {
  assert.equal(conf.detectStatusSignal('Q3 pricing — DECIDED', ['draft']), 'decided');
  assert.equal(conf.detectStatusSignal('Refund policy', ['final']), 'final');
  assert.equal(conf.detectStatusSignal('Vendor list', ['approved']), 'approved');
  assert.equal(conf.detectStatusSignal('Working notes', ['wip']), 'draft');
  assert.equal(conf.detectStatusSignal('Random page', []), null);
});

test('extractPositions only accepts explicit decision statements', () => {
  const text = [
    'Decision: use Postgres for the event store',
    'We will not use Redis for sessions',
    'Rejected: vendor lock-in for auth',
    'Some prose mentions Postgres and Redis without deciding anything.',
    'We will review the options next week',
  ].join('\n');
  const positions = conf.extractPositions(text);
  assert.equal(positions.length, 3);
  assert.deepEqual(positions[0], {
    subject: 'Postgres for the event store',
    stance: 'for',
    quote: 'Decision: use Postgres for the event store',
  });
  assert.equal(positions[1].stance, 'against');
  assert.equal(positions[1].subject, 'Redis for sessions');
  assert.equal(positions[2].stance, 'against');
});

test('searchPages normalises a CQL result page', async () => {
  const { transport, calls } = fakeTransport({
    'GET /rest/api/content/search': {
      status: 200,
      json: { results: [RAW_PAGE], totalSize: 1, start: 0 },
    },
  });
  conf.setTransportForTests(transport);
  const pages = await conf.searchPages('TEAM');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].statusSignal, 'decided');
  assert.match(calls[0].path, /cql=/);
});

test('addLabel posts a global label', async () => {
  const { transport, calls } = fakeTransport({
    'POST /rest/api/content/1001/label': { status: 200, json: {} },
  });
  conf.setTransportForTests(transport);
  await conf.addLabel('1001', 'needs-review');
  assert.deepEqual(calls[0].body, [{ prefix: 'global', name: 'needs-review' }]);
});

test('prependToPage bumps the version and keeps the existing body', async () => {
  const { transport, calls } = fakeTransport({
    'GET /rest/api/content/1001': { status: 200, json: RAW_PAGE },
    'PUT /rest/api/content/1001': {
      status: 200,
      json: { id: '1001', version: { number: 4 } },
    },
  });
  conf.setTransportForTests(transport);
  const result = await conf.prependToPage('1001', '<p>INSERTED</p>');
  assert.equal(result.version, 4);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.version.number, 4);
  assert.ok(put.body.body.storage.value.startsWith('<p>INSERTED</p>'));
  assert.ok(put.body.body.storage.value.includes('We picked tiered pricing.'));
});

test('HTTP errors surface as ConfluenceApiError with the server message', async () => {
  const { transport } = fakeTransport({
    'GET /rest/api/content/9999': { status: 404, json: { message: 'Content not found' } },
    'GET /rest/api/content/9999/property/rulebridge-duedate': {
      status: 404,
      json: { message: 'no property' },
    },
  });
  conf.setTransportForTests(transport);
  await assert.rejects(
    () => conf.getPage('9999'),
    (err) =>
      err.name === 'ConfluenceApiError' && err.status === 404 && /Content not found/.test(err.message),
  );
});
