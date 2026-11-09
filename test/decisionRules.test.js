// Decision-rules engine tests — every rule gets a consistent case
// and at least one inconsistent case, with the exact fix the engine
// must offer. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPage,
  checkLinkedPair,
  checkPageAndPair,
} from '../src/lib/decisionRules.js';

function page(overrides = {}) {
  return {
    id: '1001',
    title: 'Team update',
    spaceKey: 'TEAM',
    status: 'current',
    statusSignal: null,
    labels: [],
    bodyText: 'Weekly notes. The roadmap review moved to next week.',
    dueDate: null,
    ...overrides,
  };
}

function rulesOf(result) {
  return result.findings.map((f) => f.rule);
}

// --- Rule 1: decided but open questions ------------------------------------

test('decided page with an open question drifts and offers the decision log', () => {
  const r = checkPage(page({
    title: 'Q3 pricing — DECIDED',
    statusSignal: 'decided',
    bodyText: 'We picked tiered pricing.\nOpen question: who owns the grandfathering exception?',
  }));
  assert.equal(r.consistent, false);
  assert.deepEqual(rulesOf(r), ['decided-but-open-questions']);
  assert.equal(r.findings[0].fix.kind, 'insert-decision-log');
  assert.match(r.findings[0].fix.question, /grandfathering/);
  assert.equal(r.suggestedAction, 'offer-decision-log');
  assert.equal(r.primaryRule, 'decided-but-open-questions');
});

test('decided page whose questions are all answered is consistent', () => {
  const r = checkPage(page({
    title: 'Q3 pricing — DECIDED',
    statusSignal: 'decided',
    bodyText: 'We picked tiered pricing. The grandfathering exception is owned by Finance (answered 2026-10-02).',
  }));
  assert.equal(r.consistent, true);
  assert.deepEqual(r.findings, []);
});

test('an ordinary question on an undecided page does not fire rule 1', () => {
  const r = checkPage(page({
    title: 'Pricing brainstorm',
    statusSignal: null,
    bodyText: 'Open question: who owns the grandfathering exception?',
  }));
  assert.equal(r.consistent, true);
});

test('an FAQ-style question does not fire rule 1 even on a decided page', () => {
  const r = checkPage(page({
    statusSignal: 'decided',
    bodyText: 'Decision taken.\nHow do I reset my password?',
  }));
  assert.equal(r.consistent, true);
});

// --- Rule 2: decided but open actions --------------------------------------

test('decided page with an open action item drifts', () => {
  const r = checkPage(page({
    statusSignal: 'approved',
    bodyText: 'Budget approved.\n- [ ] Send the signed summary to Legal',
  }));
  assert.equal(r.consistent, false);
  assert.deepEqual(rulesOf(r), ['decided-but-open-actions']);
  assert.equal(r.findings[0].evidence.openActions.length, 1);
  assert.match(r.findings[0].claim, /Send the signed summary/);
});

test('decided page with only completed actions is consistent', () => {
  const r = checkPage(page({
    statusSignal: 'approved',
    bodyText: 'Budget approved.\n- [x] Send the signed summary to Legal',
  }));
  assert.equal(r.consistent, true);
});

test('open actions on a draft page do not fire rule 2 (nothing declared)', () => {
  const r = checkPage(page({
    statusSignal: 'draft',
    bodyText: 'Draft notes.\n- [ ] Send the signed summary to Legal',
  }));
  assert.equal(r.consistent, true);
});

// --- Rule 3: owner without due date ----------------------------------------

test('action naming an owner but no date drifts, on any page', () => {
  const r = checkPage(page({
    statusSignal: 'proposed',
    bodyText: '- [ ] Maya Chen to confirm the discount ceiling',
  }));
  assert.equal(r.consistent, false);
  assert.deepEqual(rulesOf(r), ['owner-without-due-date']);
  assert.equal(r.findings[0].evidence.owner, 'Maya Chen');
  assert.equal(r.findings[0].fix.owner, 'Maya Chen');
});

test('@mention owner without a date drifts', () => {
  const r = checkPage(page({
    bodyText: '- [ ] Confirm the discount ceiling @Maya Chen',
  }));
  assert.deepEqual(rulesOf(r), ['owner-without-due-date']);
});

test('owner with a due date on the line is consistent', () => {
  const r = checkPage(page({
    bodyText: '- [ ] Maya Chen to confirm the discount ceiling by Friday',
  }));
  assert.equal(r.consistent, true);
});

test('a page-level due date covers owner actions', () => {
  const r = checkPage(page({
    dueDate: '2026-12-01',
    bodyText: '- [ ] Maya Chen to confirm the discount ceiling',
  }));
  assert.equal(r.consistent, true);
});

test('unowned action without a date does not fire rule 3', () => {
  const r = checkPage(page({
    bodyText: '- [ ] Confirm the discount ceiling with Finance',
  }));
  assert.equal(r.consistent, true);
});

// --- Rule 4: final with placeholders ---------------------------------------

test('final page containing TBD drifts and offers the flag fix', () => {
  const r = checkPage(page({
    statusSignal: 'final',
    bodyText: 'The refund window is TBD for annual plans.',
  }));
  assert.equal(r.consistent, false);
  assert.deepEqual(rulesOf(r), ['final-with-placeholders']);
  assert.deepEqual(r.findings[0].evidence.placeholders, ['TBD']);
  assert.equal(r.findings[0].fix.kind, 'flag-page');
  assert.equal(r.suggestedAction, 'offer-flag-page');
});

test('final page with finished text is consistent', () => {
  const r = checkPage(page({
    statusSignal: 'final',
    bodyText: 'The refund window is 30 days for annual plans.',
  }));
  assert.equal(r.consistent, true);
});

test('placeholders on a draft page are honest, not a contradiction', () => {
  const r = checkPage(page({
    statusSignal: 'draft',
    bodyText: 'The refund window is TBD for annual plans. TODO: check with Legal.',
  }));
  assert.equal(r.consistent, true);
});

test('multiple placeholder kinds are reported together', () => {
  const r = checkPage(page({
    statusSignal: 'final',
    bodyText: 'TODO: write this section. Lorem ipsum dolor sit amet.',
  }));
  assert.deepEqual(rulesOf(r), ['final-with-placeholders']);
  assert.deepEqual(r.findings[0].evidence.placeholders, ['TODO', 'lorem ipsum']);
});

// --- Rule 5: draft label on a final-titled page ----------------------------

test('draft label plus FINAL title drifts', () => {
  const r = checkPage(page({
    title: 'Refund policy — FINAL',
    statusSignal: 'final',
    labels: ['policy', 'draft'],
    bodyText: 'The refund window is 30 days.',
  }));
  assert.equal(r.consistent, false);
  assert.deepEqual(rulesOf(r), ['draft-labeled-final']);
  assert.equal(r.findings[0].evidence.label, 'draft');
  assert.equal(r.findings[0].claim, 'FINAL');
});

test('wip label plus APPROVED title drifts', () => {
  const r = checkPage(page({
    title: 'Vendor list (approved)',
    labels: ['wip'],
    bodyText: 'All vendors reviewed.',
  }));
  assert.deepEqual(rulesOf(r), ['draft-labeled-final']);
});

test('draft label on a plainly-titled draft page is consistent', () => {
  const r = checkPage(page({
    title: 'Refund policy — working notes',
    statusSignal: 'draft',
    labels: ['draft'],
    bodyText: 'The refund window is 30 days.',
  }));
  assert.equal(r.consistent, true);
});

// --- Combined ----------------------------------------------------------------

test('multiple contradictions are all reported, page-local order kept', () => {
  const r = checkPage(page({
    statusSignal: 'decided',
    bodyText: [
      'Decision taken.',
      '- [ ] Maya Chen to confirm the discount ceiling',
      'Open question: who owns the grandfathering exception?',
    ].join('\n'),
  }));
  assert.equal(r.consistent, false);
  assert.deepEqual(rulesOf(r), [
    'decided-but-open-questions',
    'decided-but-open-actions',
    'owner-without-due-date',
  ]);
  assert.match(r.verdict, /3 contradictions detected/);
});

test('a clean decided page is fully consistent', () => {
  const r = checkPage(page({
    title: 'Q3 pricing — DECIDED',
    statusSignal: 'decided',
    labels: ['decision'],
    bodyText: 'Decision: use tiered pricing.\n- [x] Maya Chen confirmed the ceiling on 2026-10-02',
    dueDate: '2026-10-02',
  }));
  assert.equal(r.consistent, true);
  assert.equal(r.verdict, 'The page says what it means — no contradictions detected.');
  assert.equal(r.primaryRule, null);
  assert.equal(r.suggestedAction, null);
});

// --- Rule 6: contradictory linked decisions ---------------------------------

const PAGE_A = {
  id: '2001',
  title: 'Platform decision',
  positions: [{ subject: 'Postgres', stance: 'for', quote: 'Decision: use Postgres' }],
};
const PAGE_B_AGAINST = {
  id: '2002',
  title: 'Data review',
  positions: [{ subject: 'Postgres', stance: 'against', quote: 'Rejected: Postgres' }],
};

test('opposite explicit stances on the same subject contradict', () => {
  const r = checkLinkedPair({ topic: 'database', a: PAGE_A, b: PAGE_B_AGAINST });
  assert.equal(r.consistent, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'contradictory-linked-decisions');
  assert.equal(r.findings[0].evidence.a.stance, 'for');
  assert.equal(r.findings[0].evidence.b.stance, 'against');
  assert.equal(r.findings[0].fix.kind, 'flag-page');
});

test('agreeing stances do not contradict', () => {
  const b = {
    id: '2003',
    title: 'Infra notes',
    positions: [{ subject: 'Postgres', stance: 'for', quote: 'Decision: use Postgres' }],
  };
  const r = checkLinkedPair({ topic: 'database', a: PAGE_A, b });
  assert.equal(r.consistent, true);
});

test('a neutral counterpart does not contradict', () => {
  const b = {
    id: '2004',
    title: 'Database survey',
    positions: [{ subject: 'Postgres', stance: 'neutral', quote: 'Postgres is one option' }],
  };
  const r = checkLinkedPair({ topic: 'database', a: PAGE_A, b });
  assert.equal(r.consistent, true);
});

test('positions on different subjects never contradict', () => {
  const b = {
    id: '2005',
    title: 'Cache review',
    positions: [{ subject: 'Redis', stance: 'against', quote: 'Rejected: Redis' }],
  };
  const r = checkLinkedPair({ topic: 'database', a: PAGE_A, b });
  assert.equal(r.consistent, true);
});

test('a one-sided position cannot contradict', () => {
  const b = { id: '2006', title: 'Empty page', positions: [] };
  const r = checkLinkedPair({ topic: 'database', a: PAGE_A, b });
  assert.equal(r.consistent, true);
});

test('checkPageAndPair merges pair findings after page findings', () => {
  const pg = page({
    statusSignal: 'final',
    bodyText: 'The refund window is TBD for annual plans.',
  });
  const r = checkPageAndPair(pg, { topic: 'database', a: PAGE_A, b: PAGE_B_AGAINST });
  assert.deepEqual(rulesOf(r), ['final-with-placeholders', 'contradictory-linked-decisions']);
});
