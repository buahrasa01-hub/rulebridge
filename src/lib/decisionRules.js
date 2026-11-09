// ---------------------------------------------------------------------------
// RuleBridge — decision-record rules engine (pure logic, no Forge imports)
//
// Idea: a Confluence decision record or meeting-notes page *declares* a
// state about itself — a title like "Q3 pricing — DECIDED", a status
// macro set to "Final", the word "approved" near the top. The body of
// the page then either backs that declaration up or quietly contradicts
// it: open questions still unanswered, owners with no dates, TBD
// placeholders in a "final" policy, action items that were never
// assigned. The page reads as settled; the work is not. Teams act on
// the declaration and discover the contradiction weeks later.
//
// This engine checks the declaration against the body deterministically:
// same input, same verdict, no LLM, no network. That determinism is
// deliberate, for the same reason as in IncidentBridge — a checker that
// hallucinates contradictions destroys trust faster than the drift it
// hunts. Every rule here is narrow and explainable in one sentence.
//
// Input shape (a normalised page, see src/lib/confluenceClient.js):
//   {
//     id, title, spaceKey?,
//     status: string | undefined,   // Confluence content status, e.g.
//                                   // 'current' | 'draft' | 'archived'
//     statusSignal: 'decided' | 'final' | 'approved' | 'draft'
//                 | 'proposed' | null,
//                                   // strongest declared state found in
//                                   // the title + labels (client does
//                                   // this mapping, deterministically)
//     labels: string[],             // lower-cased label names
//     bodyText: string,             // plain text of the page body
//     dueDate?: string | null,      // explicit page-level due date
//                                   // (content property), if the team
//                                   // records one — null otherwise
//   }
//
// Rules that compare two pages take a pair:
//   { topic, a: page, b: page } — two pages about the same topic whose
//   extracted position statements the client has already paired up (the
//   client is responsible for pairing; the engine only compares). For
//   the pair rule the pages additionally carry:
//     positions: [{ subject, stance, quote }]
//   where stance is 'for' | 'against' | 'neutral' — extracted by the
//   client from explicit position markers (see confluenceClient
//   extractPositions), again deterministically.
//
// Output of checkPage() / checkLinkedPair():
//   {
//     consistent: boolean,        // true iff findings is empty
//     findings: [Finding],
//     verdict: string,            // one-line human summary
//     // primary-finding shortcuts for the byline UI:
//     primaryRule,                // rule name of findings[0] or null
//     suggestedAction,            // 'offer-decision-log' |
//                                 // 'offer-flag-page' |
//                                 // 'offer-summary-draft' | null
//   }
//
// A Finding is:
//   {
//     rule: 'decided-but-open-questions' | 'decided-but-open-actions'
//         | 'owner-without-due-date' | 'final-with-placeholders'
//         | 'draft-labeled-final'
//         | 'contradictory-linked-decisions',
//     claim: string | null,      // the exact words that triggered it
//     message: string,           // human-readable explanation
//     evidence: { ... },         // rule-specific structured detail
//     fix: {                     // the one-click fix on offer
//       kind: 'insert-decision-log' | 'flag-page' | 'draft-summary',
//       label: string,           // button label for the UI
//       // rule-specific payload:
//       owner?: string, question?: string, item?: string,
//       topics?: string[],
//     } | null,
//   }
//
// Nothing in this file writes anything. Fixes are only *described*
// here; src/lib/fixes.js performs them after an explicit human press.
// ---------------------------------------------------------------------------

// Declared states that mean "this page is settled" — the rules only
// fire against such a declaration. A page that honestly says "draft"
// or "proposed" is not contradicting itself, whatever its body holds.
export const SETTLED_SIGNALS = new Set(['decided', 'final', 'approved']);

// An open question: a line ending in '?' that is phrased as something
// the team still has to resolve. The marker set is deliberately narrow
// (open/tbd/undecided/... or "who/what/when..." decision questions) —
// a random FAQ question on a policy page must not fire the rule.
const OPEN_QUESTION_MARKERS =
  /\b(open question|unanswered|unresolved|still open|tbd|to be decided|to be confirmed|awaiting (an? )?(answer|input|decision)|pending (an? )?(answer|decision)|need(s)? (an? )?(answer|input)|who (owns|will|should)|what is the (final|agreed)|when (will|should|is))\b/i;

// Confluence inline tasks export from storage format as "- [ ]" /
// "[ ]" checklist items; an unchecked box is an action that is still
// open by the page's own admission. Completed tasks use "[x]".
const OPEN_ACTION_PATTERN = /^\s*(?:[-*]\s*)?\[\s\]\s*(.+)$/;

// An owner attribution inside an action line: "@Name", "Owner: Name"
// or a leading "Name to ...". Names are 1–3 capitalised words; the
// pattern deliberately refuses lowercase or sentence-like text so a
// line of prose is never mistaken for an assignment.
const OWNER_PATTERNS = [
  /@([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
  /\bowner\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i,
  /^\s*(?:[-*]\s*)?(?:\[\s\]\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+to\s+/,
];

// A due-date anywhere near an action: an ISO date, a month-name date,
// or the words "by <weekday>". Kept just as narrow as IncidentBridge's
// date rule — slash dates (03/04) are locale-ambiguous and a checker
// must not guess.
const DUE_DATE_PATTERN =
  /\b(due|by|before|deadline)\b[^.\n]{0,30}?(\d{4}-\d{2}-\d{2}|\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s\d{4})?|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day)\b/i;

// Placeholders that mean "this text is not finished", wherever they
// appear in a page that calls itself final.
const PLACEHOLDER_PATTERNS = [
  { pattern: /\bTBD\b/, label: 'TBD' },
  { pattern: /\bTODO\b/, label: 'TODO' },
  { pattern: /\bFIXME\b/, label: 'FIXME' },
  { pattern: /\bXXX\b/, label: 'XXX' },
  { pattern: /\[\s*(?:insert|add|TBD|TODO)[^\]]*\]/i, label: '[insert …] bracket' },
  { pattern: /\blorem ipsum\b/i, label: 'lorem ipsum' },
];

// Labels a team puts on a page that is still being drafted.
const DRAFT_LABELS = new Set(['draft', 'wip', 'work-in-progress', 'in-progress', 'under-review']);

// Title words that declare the page final, for the draft-vs-final rule.
const FINAL_TITLE_PATTERN = /\b(final|approved|signed off|ratified)\b/i;

function linesOf(bodyText) {
  return (bodyText || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

// Returns the first line that reads as an open question, or null.
export function findOpenQuestion(bodyText) {
  for (const line of linesOf(bodyText)) {
    const t = line.trim();
    if (!t.endsWith('?')) {
      continue;
    }
    if (t.length < 8 || t.length > 160) {
      continue; // too short to be a decision question, too long to quote
    }
    if (OPEN_QUESTION_MARKERS.test(t)) {
      return t;
    }
  }
  return null;
}

// Returns every open (unchecked) action item line, in page order.
export function findOpenActions(bodyText) {
  const items = [];
  for (const line of linesOf(bodyText)) {
    const match = line.match(OPEN_ACTION_PATTERN);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

// Extracts an owner name from an action line, or null.
export function findOwner(line) {
  for (const pattern of OWNER_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

// True when the line itself carries a due date.
export function hasDueDate(line) {
  return DUE_DATE_PATTERN.test(line);
}

// Returns every placeholder kind present in the text (deduplicated).
export function findPlaceholders(bodyText) {
  const found = [];
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(bodyText || '')) {
      found.push(label);
    }
  }
  return found;
}

function buildResult(findings) {
  const primary = findings[0] || null;
  return {
    consistent: findings.length === 0,
    findings,
    verdict:
      findings.length === 0
        ? 'The page says what it means — no contradictions detected.'
        : findings.length === 1
          ? primary.message
          : `${findings.length} contradictions detected. First: ${primary.message}`,
    primaryRule: primary ? primary.rule : null,
    suggestedAction: primary
      ? primary.fix
        ? {
            'insert-decision-log': 'offer-decision-log',
            'flag-page': 'offer-flag-page',
            'draft-summary': 'offer-summary-draft',
          }[primary.fix.kind] || null
        : null
      : null,
  };
}

/**
 * Checks one page: does its body contradict the state it declares?
 * Rules 1–5. See the file header for the input/output contract.
 */
export function checkPage(page) {
  const bodyText = page.bodyText || '';
  const signal = page.statusSignal || null;
  const settled = signal !== null && SETTLED_SIGNALS.has(signal);
  const labels = (page.labels || []).map((l) => String(l).toLowerCase());
  const findings = [];

  const openQuestion = findOpenQuestion(bodyText);
  const openActions = findOpenActions(bodyText);

  // Rule 1 — DECIDED but the body still asks an open question. A
  // decision record with an unresolved question in it is not decided;
  // the question is the unfinished part of the decision.
  if (settled && openQuestion) {
    findings.push({
      rule: 'decided-but-open-questions',
      claim: openQuestion,
      message:
        `The page declares itself "${signal}" but still contains an open question: ` +
        `"${openQuestion}" — the decision is not closed while that question stands.`,
      evidence: { question: openQuestion },
      fix: {
        kind: 'insert-decision-log',
        question: openQuestion,
        label: 'Log this question in the decision log',
      },
    });
  }

  // Rule 2 — DECIDED but action items are still open. The follow-up
  // work a decision creates is part of the decision; unchecked boxes
  // mean the page's "done" story is incomplete.
  if (settled && openActions.length > 0) {
    findings.push({
      rule: 'decided-but-open-actions',
      claim: openActions[0],
      message:
        `The page declares itself "${signal}" but ${openActions.length} action item(s) are ` +
        `still open, starting with: "${openActions[0]}".`,
      evidence: { openActions },
      fix: {
        kind: 'insert-decision-log',
        item: openActions[0],
        label: 'Log the open actions in the decision log',
      },
    });
  }

  // Rule 3 — an action item names an owner but carries no due date,
  // and the page records no page-level due date either. This one
  // fires regardless of the declared state: an unassigned-in-time
  // commitment is a contradiction in any record that presents the
  // item as agreed work. Fires once, for the first such item — one
  // finding per page keeps the report actionable.
  if (!page.dueDate) {
    for (const itemLine of openActions) {
      const owner = findOwner(itemLine);
      if (owner && !hasDueDate(itemLine)) {
        findings.push({
          rule: 'owner-without-due-date',
          claim: itemLine,
          message:
            `Action item names an owner ("${owner}") but has no due date: "${itemLine}". ` +
            'An owner without a date is a hope, not a commitment.',
          evidence: { owner, item: itemLine },
          fix: {
            kind: 'insert-decision-log',
            owner,
            item: itemLine,
            label: `Log "${owner}" in the decision log (date still needed)`,
          },
        });
        break;
      }
    }
  }

  // Rule 4 — a page that calls itself FINAL still contains draft
  // placeholders. TBD in a final policy is the policy contradicting
  // its own title.
  if (signal === 'final') {
    const placeholders = findPlaceholders(bodyText);
    if (placeholders.length > 0) {
      findings.push({
        rule: 'final-with-placeholders',
        claim: placeholders.join(', '),
        message:
          `The page declares itself "final" but still contains placeholder text ` +
          `(${placeholders.join(', ')}). A final page cannot contain unfinished text.`,
        evidence: { placeholders },
        fix: {
          kind: 'flag-page',
          label: 'Flag this page as "needs review"',
        },
      });
    }
  }

  // Rule 5 — the labels say "draft" while the title declares the page
  // final/approved. Two metadata voices disagreeing — the Confluence
  // equivalent of a summary/status drift.
  const draftLabel = labels.find((l) => DRAFT_LABELS.has(l));
  if (draftLabel && FINAL_TITLE_PATTERN.test(page.title || '')) {
    const match = (page.title || '').match(FINAL_TITLE_PATTERN);
    findings.push({
      rule: 'draft-labeled-final',
      claim: match ? match[0] : 'final',
      message:
        `The title declares this page "${match ? match[0] : 'final'}" but it still carries ` +
        `the label "${draftLabel}" — readers cannot tell whether to trust it as final.`,
      evidence: { label: draftLabel, titleClaim: match ? match[0] : null },
      fix: {
        kind: 'flag-page',
        label: 'Flag this page as "needs review"',
      },
    });
  }

  return buildResult(findings);
}

/**
 * Rule 6 — two linked decision pages contradict each other on the same
 * topic. Deliberately the most conservative rule in the engine: it
 * fires ONLY when both pages state an explicit, opposite stance
 * ('for' vs 'against') on the exact same subject string. Similar
 * topics, one-sided statements, or neutral mentions never fire —
 * a false "you contradict yourselves" accusation is the worst output
 * this tool can produce, so the rule would rather miss than guess.
 *
 * Input: { topic, a: pageWithPositions, b: pageWithPositions } where
 * each page carries positions: [{ subject, stance, quote }].
 * Output: the standard result shape; findings is empty or has the
 * single contradiction finding.
 */
export function checkLinkedPair(pair) {
  const findings = [];
  const a = pair.a || {};
  const b = pair.b || {};
  const bBySubject = new Map();
  for (const p of b.positions || []) {
    bBySubject.set(String(p.subject).toLowerCase(), p);
  }
  for (const pa of a.positions || []) {
    const pb = bBySubject.get(String(pa.subject).toLowerCase());
    if (!pb) {
      continue; // stated by one page only — no contradiction possible
    }
    const opposite =
      (pa.stance === 'for' && pb.stance === 'against') ||
      (pa.stance === 'against' && pb.stance === 'for');
    if (!opposite) {
      continue; // agreeing or neutral — nothing to report
    }
    findings.push({
      rule: 'contradictory-linked-decisions',
      claim: pa.subject,
      message:
        `Linked decisions contradict each other on "${pa.subject}": ` +
        `"${a.title}" says ${pa.stance} ("${pa.quote}") while ` +
        `"${b.title}" says ${pb.stance} ("${pb.quote}").`,
      evidence: {
        topic: pair.topic || pa.subject,
        subject: pa.subject,
        a: { pageId: a.id || null, title: a.title || '', stance: pa.stance, quote: pa.quote },
        b: { pageId: b.id || null, title: b.title || '', stance: pb.stance, quote: pb.quote },
      },
      fix: {
        kind: 'flag-page',
        topics: [pa.subject],
        label: 'Flag both pages as "needs review"',
      },
    });
    break; // one contradiction per pair is the actionable unit
  }
  return buildResult(findings);
}

/**
 * Convenience for the space scan: checks a page and, when a linked
 * counterpart is supplied, the pair as well, merging findings. The
 * merged result keeps checkPage's findings first (page-local facts
 * before cross-page ones).
 */
export function checkPageAndPair(page, pair) {
  const single = checkPage(page);
  if (!pair) {
    return single;
  }
  const linked = checkLinkedPair(pair);
  if (linked.findings.length === 0) {
    return single;
  }
  return buildResult([...single.findings, ...linked.findings]);
}
