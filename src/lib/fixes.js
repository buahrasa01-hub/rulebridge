// ---------------------------------------------------------------------------
// RuleBridge — fix executor + space scan
//
// The rules engine (decisionRules.js) only *describes* fixes; this
// module performs them. A fix runs only when a human presses a button
// in the byline item or the space page — never automatically, never
// as a side effect of a scan, and (the product rule Bayu set) NEVER by
// silently rewriting a page body: every fix is a visible, labelled,
// additive change — a prepended block or an added label — that the
// human saw described before pressing.
//
// Fix descriptors come straight from a finding:
//   { kind: 'insert-decision-log', question? | item?, owner? }
//   { kind: 'flag-page' }
//   { kind: 'draft-summary' }       — standalone affordance, built from
//                                     the page's current findings
//
// applyFix(client, page, fix) takes the API client as its first
// argument (dependency injection), so the whole executor is
// unit-testable with the fake transport from confluenceClient.js.
// ---------------------------------------------------------------------------

import { escapeStorage } from './confluenceClient.js';
import { checkPage, checkLinkedPair } from './decisionRules.js';

// The label a flag applies. Deliberately a review marker, not a
// verdict: the page goes back into the team's queue instead of being
// silently edited into compliance.
export const FLAG_LABEL = 'needs-review';

// Wraps content in a Confluence info macro so a RuleBridge-inserted
// block is visually distinct from the page's own text and removable
// in one delete by the page owner.
function infoMacro(title, innerStorage) {
  return (
    '<ac:structured-macro ac:name="info">' +
    `<ac:parameter ac:name="title">${escapeStorage(title)}</ac:parameter>` +
    `<ac:rich-text-body>${innerStorage}</ac:rich-text-body>` +
    '</ac:structured-macro>'
  );
}

function decisionLogTable(page, finding) {
  const f = finding || {};
  const row = (label, value) => `<tr><th>${label}</th><td>${escapeStorage(value || '—')}</td></tr>`;
  return (
    '<table><tbody>' +
    '<tr><th colspan="2">RuleBridge decision log</th></tr>' +
    row('Page', page.title) +
    row('Declared state', page.statusSignal || '—') +
    row('Contradiction found', f.rule || 'manual summary') +
    row('Open question', f.fix && f.fix.question) +
    row('Open action', f.fix && f.fix.item) +
    row('Owner named', f.fix && f.fix.owner) +
    row('Due date', 'STILL MISSING — set one') +
    '</tbody></table>'
  );
}

function summaryDraftBlock(page, findings) {
  const lines = findings.map(
    (f) => `<li><strong>${escapeStorage(f.rule)}:</strong> ${escapeStorage(f.message)}</li>`,
  );
  const inner =
    '<p>Inserted by RuleBridge at the top of this page at a human\'s request. ' +
    'Nothing below this block was changed.</p>' +
    (lines.length
      ? `<p>Unresolved contradictions on this page:</p><ul>${lines.join('')}</ul>`
      : '<p>No contradictions were found on this page.</p>');
  return infoMacro('RuleBridge — unresolved items', inner);
}

/**
 * Applies one fix to one page.
 * @returns {Promise<{applied: boolean, kind: string, detail: string}>}
 *   `applied: false` is returned (not thrown) for expected dead ends.
 *   Transport/API failures throw ConfluenceApiError from the client.
 */
export async function applyFix(client, page, fix, extras = {}) {
  if (!fix || !fix.kind) {
    throw new Error('applyFix requires a fix descriptor with a kind.');
  }

  if (fix.kind === 'flag-page') {
    // The contradiction fix that touches no body text at all: the
    // page joins the review queue under a visible label.
    if ((page.labels || []).includes(FLAG_LABEL)) {
      return {
        applied: false,
        kind: fix.kind,
        detail: `This page already carries the "${FLAG_LABEL}" label — no change made.`,
      };
    }
    await client.addLabel(page.id, FLAG_LABEL);
    return {
      applied: true,
      kind: fix.kind,
      detail: `Added the "${FLAG_LABEL}" label to "${page.title}". The page body was not changed.`,
    };
  }

  if (fix.kind === 'insert-decision-log') {
    // Inserts a decision-log table at the page top that records the
    // contradiction, the owner, and the missing date — turning an
    // implicit loose end into tracked, visible work. The existing
    // body is preserved verbatim below the inserted block.
    const finding = extras.finding || { rule: 'manual', fix };
    const block = infoMacro(
      'RuleBridge decision log',
      decisionLogTable(page, finding),
    );
    const result = await client.prependToPage(page.id, block);
    return {
      applied: true,
      kind: fix.kind,
      detail:
        `Inserted the decision log at the top of "${page.title}" (now version ${result.version}). ` +
        'The original body is unchanged below the inserted block.',
    };
  }

  if (fix.kind === 'draft-summary') {
    // Drafts the unresolved-items summary at the page top from the
    // page's CURRENT findings (recomputed by the caller / here from
    // `page`). Additive only, like every other fix.
    const result0 = checkPage(page);
    const block = summaryDraftBlock(page, result0.findings);
    const result = await client.prependToPage(page.id, block);
    return {
      applied: true,
      kind: fix.kind,
      detail:
        `Drafted the unresolved-items summary at the top of "${page.title}" ` +
        `(${result0.findings.length} contradiction(s) listed; now version ${result.version}). ` +
        'The original body is unchanged below the inserted block.',
    };
  }

  throw new Error(`Unknown fix kind: ${fix.kind}`);
}

/**
 * Scans a whole space for contradictions: fetches pages (bounded by
 * the client's cap), runs the page rules over each, then pairs pages
 * that state positions on the same subject and runs the pair rule.
 * @returns {Promise<{spaceKey, scanned, flagged, pairs}>}
 *   flagged: [{ page, findings, verdict }] for pages failing Rule 1–5.
 *   pairs:   [{ topic, aId, bId, findings, verdict }] for Rule 6 hits.
 */
export async function scanSpace(client, spaceKey, options = {}) {
  const pages = await client.searchPages(spaceKey, options);
  const flagged = [];
  for (const page of pages) {
    const result = checkPage(page);
    if (!result.consistent) {
      flagged.push({ page, findings: result.findings, verdict: result.verdict });
    }
  }
  // Rule 6 pairing: pages stating a position on the same subject are
  // candidate counterparts. Deterministic and conservative — the pair
  // rule itself still requires explicit opposite stances to fire.
  const pairs = [];
  const bySubject = new Map();
  for (const page of pages) {
    for (const position of page.positions || []) {
      const key = position.subject.toLowerCase();
      if (!bySubject.has(key)) {
        bySubject.set(key, []);
      }
      bySubject.get(key).push(page);
    }
  }
  const seenPairs = new Set();
  for (const [subject, holders] of bySubject) {
    for (let i = 0; i < holders.length; i += 1) {
      for (let j = i + 1; j < holders.length; j += 1) {
        const pairKey = `${holders[i].id}:${holders[j].id}:${subject}`;
        if (seenPairs.has(pairKey) || holders[i].id === holders[j].id) {
          continue;
        }
        seenPairs.add(pairKey);
        const result = checkLinkedPair({
          topic: subject,
          a: holders[i],
          b: holders[j],
        });
        if (result.findings.length > 0) {
          pairs.push({
            topic: subject,
            aId: holders[i].id,
            bId: holders[j].id,
            findings: result.findings,
            verdict: result.verdict,
          });
        }
      }
    }
  }
  return { spaceKey, scanned: pages.length, flagged, pairs };
}
