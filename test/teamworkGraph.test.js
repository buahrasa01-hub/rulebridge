// teamworkGraph tests — the graph client runs against an injected
// fake transport, so the query text, the ARI building, the response
// normalisation, the Rule 6 pairing over graph links and the verdict
// merge are verified with no Atlassian site, no Forge runtime and no
// credentials. The fake returns the parsed GraphQL body
// { data, errors }, exactly what the live @forge/api transport
// returns from response.json().
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setTransportForTests,
  buildPageAri,
  LINKED_PAGES_QUERY,
  parseLinkedPages,
  getLinkedPages,
  findGraphPairs,
  mergeGraphPairs,
  TeamworkGraphError,
} from '../src/lib/teamworkGraph.js';
import { checkPage } from '../src/lib/decisionRules.js';

afterEach(() => setTransportForTests(null));

// A fake transport that records calls and answers one canned body.
function fakeTransport(body) {
  const calls = [];
  const transport = async (query, variables) => {
    calls.push({ query, variables });
    return body;
  };
  return { transport, calls };
}

// Storage body of a linked page that states the OPPOSITE position to
// the checked page below ("Decision: use Postgres" vs "Rejected:
// Postgres" — the exact explicit forms the position extractor reads).
const LINKED_STORAGE =
  '<p>Decision log, updated after the migration review.</p>' +
  '<p>Rejected: Postgres</p>' +
  '<p>We will not use Postgres for the new store.</p>';

const GRAPH_DATA = {
  confluencePageLinkedConfluencePages: {
    edges: [
      {
        node: {
          id: 'ari:cloud:confluence:cloud-1:page/200',
          pageId: '200',
          title: 'Storage backend — DECIDED',
          space: { key: 'TEAM' },
          content: { storage: { value: LINKED_STORAGE } },
        },
      },
      {
        node: {
          id: 'ari:cloud:confluence:cloud-1:page/201',
          pageId: '201',
          title: 'Q3 roadmap',
          space: { key: 'TEAM' },
          content: { storage: { value: '<p>Roadmap notes, no positions stated.</p>' } },
        },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

const CHECKED_PAGE = {
  id: '100',
  title: 'Storage backend — DECIDED',
  spaceKey: 'TEAM',
  status: 'current',
  statusSignal: 'decided',
  labels: [],
  bodyText: 'Decision: use Postgres\nThe team picked Postgres for the new store.',
  positions: [
    { subject: 'Postgres', stance: 'for', quote: 'Decision: use Postgres' },
  ],
  dueDate: null,
};

test('buildPageAri builds the documented Confluence page ARI', () => {
  assert.equal(
    buildPageAri('a436116f-02ce-4520-8fbb-7301462a1674', '100'),
    'ari:cloud:confluence:a436116f-02ce-4520-8fbb-7301462a1674:page/100',
  );
  assert.equal(buildPageAri(null, '100'), null);
  assert.equal(buildPageAri('cloud-id', null), null);
  assert.equal(buildPageAri('', ''), null);
});

test('the query is one operation with the linked-pages curated field and no Cypher', () => {
  assert.match(LINKED_PAGES_QUERY, /query rulebridge_linkedPages\(\$id: ID!\)/);
  assert.match(LINKED_PAGES_QUERY, /confluencePageLinkedConfluencePages\(id: \$id, first: 25\)/);
  assert.match(LINKED_PAGES_QUERY, /content\s*{\s*storage\s*{\s*value\s*}\s*}/);
  assert.doesNotMatch(LINKED_PAGES_QUERY, /MATCH|cypherQuery|customQuery/i);
});

test('parseLinkedPages normalises graph pages for the rules engine', () => {
  const pages = parseLinkedPages(GRAPH_DATA);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].id, '200');
  assert.equal(pages[0].title, 'Storage backend — DECIDED');
  assert.equal(pages[0].spaceKey, 'TEAM');
  assert.match(pages[0].bodyText, /Rejected: Postgres/);
  assert.equal(pages[0].statusSignal, 'decided');
  // The explicit positions the pair rule needs are extracted.
  // ("We will not use Postgres for the new store" states its
  // subject as the full phrase, per the extractor's patterns.)
  assert.deepEqual(
    pages[0].positions.map((p) => `${p.stance}:${p.subject}`),
    ['against:Postgres', 'against:Postgres for the new store'],
  );
  assert.deepEqual(pages[1].positions, []);
  assert.equal(pages[1].statusSignal, null);
});

test('parseLinkedPages tolerates missing fields (ungranted scope reads as empty)', () => {
  assert.deepEqual(parseLinkedPages(null), []);
  assert.deepEqual(parseLinkedPages({}), []);
  const partial = parseLinkedPages({
    confluencePageLinkedConfluencePages: { edges: [{ node: { title: 'Bare page' } }] },
  });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, null);
  assert.equal(partial[0].bodyText, '');
  assert.deepEqual(partial[0].positions, []);
});

test('getLinkedPages sends the ARI and returns parsed pages', async () => {
  const { transport, calls } = fakeTransport({ data: GRAPH_DATA });
  setTransportForTests(transport);
  const linked = await getLinkedPages({ cloudId: 'cloud-1', pageId: '100' });
  assert.equal(linked.available, true);
  assert.equal(linked.pages.length, 2);
  assert.equal(linked.pages[0].id, '200');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables.id, 'ari:cloud:confluence:cloud-1:page/100');
  assert.equal(calls[0].query, LINKED_PAGES_QUERY);
});

test('getLinkedPages sends nothing without a buildable ARI', async () => {
  const { transport, calls } = fakeTransport({ data: GRAPH_DATA });
  setTransportForTests(transport);
  const linked = await getLinkedPages({ cloudId: null, pageId: '100' });
  assert.equal(linked.available, false);
  assert.equal(linked.reason, 'missing-cloud-id-or-page-id');
  assert.deepEqual(linked.pages, []);
  assert.equal(calls.length, 0);
});

test('getLinkedPages throws TeamworkGraphError on GraphQL errors', async () => {
  const { transport } = fakeTransport({
    data: null,
    errors: [{ message: 'Field not found' }],
  });
  setTransportForTests(transport);
  await assert.rejects(
    getLinkedPages({ cloudId: 'cloud-1', pageId: '100' }),
    (error) => error instanceof TeamworkGraphError && /Field not found/.test(error.message),
  );
});

test('findGraphPairs catches a linked page contradicting the checked page', () => {
  const pages = parseLinkedPages(GRAPH_DATA);
  const pairs = findGraphPairs(CHECKED_PAGE, pages);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].linkedPageId, '200');
  assert.equal(pairs[0].linkedTitle, 'Storage backend — DECIDED');
  assert.equal(pairs[0].findings[0].rule, 'contradictory-linked-decisions');
  assert.match(pairs[0].findings[0].message, /Postgres/);
  assert.equal(pairs[0].findings[0].fix.kind, 'flag-page');
});

test('findGraphPairs ignores agreeing pages and the page itself', () => {
  const pages = parseLinkedPages(GRAPH_DATA);
  const agreeing = pages.filter((p) => p.id === '201');
  assert.deepEqual(findGraphPairs(CHECKED_PAGE, agreeing), []);
  // A page never pairs with itself, even if it links to itself.
  assert.deepEqual(findGraphPairs(CHECKED_PAGE, [CHECKED_PAGE]), []);
  assert.deepEqual(findGraphPairs(CHECKED_PAGE, []), []);
  assert.deepEqual(findGraphPairs(CHECKED_PAGE, null), []);
});

test('mergeGraphPairs appends pair findings after page-local ones', () => {
  const pages = parseLinkedPages(GRAPH_DATA);
  const pairs = findGraphPairs(CHECKED_PAGE, pages);
  const check = checkPage(CHECKED_PAGE);
  assert.equal(check.consistent, true); // no open questions or actions
  const merged = mergeGraphPairs(check, pairs);
  assert.equal(merged.consistent, false);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].rule, 'contradictory-linked-decisions');
  assert.equal(merged.primaryRule, 'contradictory-linked-decisions');
  assert.equal(merged.suggestedAction, 'offer-flag-page');
  assert.equal(merged.graphPairs.length, 1);
  assert.equal(merged.graphPairs[0].linkedPageId, '200');
});

test('mergeGraphPairs with no pairs leaves the verdict untouched', () => {
  const check = checkPage(CHECKED_PAGE);
  const merged = mergeGraphPairs(check, []);
  assert.equal(merged.consistent, true);
  assert.equal(merged.findings.length, 0);
  assert.equal(merged.verdict, check.verdict);
  assert.deepEqual(merged.graphPairs, []);
});
