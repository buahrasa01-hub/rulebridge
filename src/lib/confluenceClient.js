// ---------------------------------------------------------------------------
// RuleBridge — Confluence API client (the mockable seam)
//
// Every product API call in the app goes through this file. The actual
// HTTP transport is a single function, `request(method, path, body)`,
// with two implementations:
//
//   * live  — @forge/api's `api.asUser().requestConfluence(...)`.
//             asUser is used throughout (never asApp) so Confluence's
//             own permission checks apply to every read and write,
//             per Forge guidance.
//   * fake  — tests inject a transport with setTransportForTests() and
//             exercise the full client logic in plain Node, with no
//             Atlassian site and no credentials.
//
// @forge/api is imported lazily, only when a live request is actually
// made, so importing this module (e.g. from the test suite) never
// requires the Forge runtime.
//
// Normalised page shape returned by getPage()/searchPages():
//   {
//     id, title, spaceKey, status,           // raw Confluence values
//     statusSignal,                          // 'decided' | 'final' |
//                                            // 'approved' | 'draft' |
//                                            // 'proposed' | null
//     labels,                                // lower-cased names
//     bodyText,                              // plain text from storage
//     dueDate,                               // page property or null
//   }
// That is exactly the input contract of src/lib/decisionRules.js.
// ---------------------------------------------------------------------------

let injectedTransport = null;

/**
 * Test seam: replace the live transport with a fake.
 * The fake receives (method, path, body) and must return
 * { status, json } where json is the already-parsed response body
 * (or null). Pass null to restore the live transport.
 */
export function setTransportForTests(transport) {
  injectedTransport = transport;
}

/** Error type carrying the HTTP status and a readable Confluence message. */
export class ConfluenceApiError extends Error {
  constructor(status, path, detail) {
    super(`Confluence API ${status} on ${path}${detail ? `: ${detail}` : ''}`);
    this.name = 'ConfluenceApiError';
    this.status = status;
    this.path = path;
  }
}

async function request(method, path, body) {
  if (injectedTransport) {
    const fake = await injectedTransport(method, path, body);
    return unwrap(fake, path);
  }
  // Live transport — lazy import so plain-Node tests never load Forge.
  const apiModule = await import('@forge/api');
  // Interop guard (same bundler-wrapping concern as the resolver):
  // use whichever module level actually exposes asUser().
  const api = [apiModule, apiModule.default, apiModule.default?.default]
    .find((candidate) => candidate && typeof candidate.asUser === 'function');
  const options = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  // The path is built entirely by this client (dynamic segments are
  // already encodeURIComponent'd), so it must go through
  // assumeTrustedRoute(): feeding a whole built path into the route``
  // tag as a single interpolated value is rejected by @forge/api with
  // "Disallowing path manipulation attempt" — that rejection is what
  // silently forced the panel's demo-fixture fallback on live sites.
  const trustedRoute = typeof apiModule.assumeTrustedRoute === 'function'
    ? apiModule.assumeTrustedRoute(path)
    : apiModule.route([path]);
  const response = await api.asUser().requestConfluence(trustedRoute, options);
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null; // e.g. 204 No Content on label edits
  }
  return unwrap({ status: response.status, json }, path);
}

function unwrap({ status, json }, path) {
  if (status >= 400) {
    const detail =
      (json && json.message) ||
      (json && (json.errorMessages || []).join('; ')) ||
      (json && json.errors && JSON.stringify(json.errors)) ||
      '';
    throw new ConfluenceApiError(status, path, detail);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Plain-text extraction from Confluence storage format (XHTML).
//
// The rules engine works on text, so extraction must be faithful about
// the structures the rules read:
//   * task lists become "- [ ] item" / "- [x] item" lines — Confluence
//     stores completion in the <ac:task-status> element;
//   * headings, paragraphs and list items become their own lines;
//   * macros collapse to their visible text (status macro text is how
//     a page declares "Decided"/"Final" inside the body).
// Deliberately small: no tables-as-grid, no nested-layout fidelity.
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] !== undefined ? NAMED_ENTITIES[body] : whole;
  });
}

export function storageToText(storage) {
  if (!storage || typeof storage !== 'string') {
    return '';
  }
  let s = storage;

  // Inline tasks first: their completion state lives in a child
  // element, so the whole <ac:task> collapses into one text line
  // carrying the checkbox marker the engine's action rule reads.
  s = s.replace(/<ac:task>[\s\S]*?<\/ac:task>/g, (task) => {
    const complete = /<ac:task-status>complete<\/ac:task-status>/.test(task);
    const bodyMatch = task.match(/<ac:task-body[^>]*>([\s\S]*?)<\/ac:task-body>/);
    const body = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, ' ') : '';
    return `\n- [${complete ? 'x' : ' '}] ${body.trim()}\n`;
  });

  // Block boundaries become newlines BEFORE tags are stripped.
  s = s.replace(/<\/(p|h[1-6]|li|tr|ac:structured-macro)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Strip every remaining tag (formatting, links, macro shells).
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Declared-state ("status signal") detection.
//
// A page declares its state in the title suffix/prefix ("… — DECIDED",
// "[FINAL] …") or in a label (decided / final / approved / draft /
// proposed). The mapping is fixed and documented here; the strongest
// signal wins, in the order decided > final > approved > proposed >
// draft, because a page that says both "draft" (stale label) and
// "DECIDED" (title) is precisely the kind of mixed message RuleBridge
// exists to catch — the settled claim is what the engine tests the
// body against, and the leftover draft label is reported by Rule 5's
// sibling signals in the findings.
// ---------------------------------------------------------------------------

const SIGNAL_PATTERNS = [
  { signal: 'decided', title: /\b(decided|decision)\b[^a-z]{0,3}$|\b(decided)\b/i, labels: ['decided', 'decision-made'] },
  { signal: 'final', title: /\b(final|signed off|ratified)\b/i, labels: ['final'] },
  { signal: 'approved', title: /\b(approved)\b/i, labels: ['approved'] },
  { signal: 'proposed', title: /\b(proposed|proposal)\b/i, labels: ['proposed'] },
  { signal: 'draft', title: /\b(draft|wip)\b/i, labels: ['draft', 'wip', 'work-in-progress'] },
];

export function detectStatusSignal(title, labels) {
  const lowerLabels = (labels || []).map((l) => String(l).toLowerCase());
  for (const { signal, title: pattern, labels: names } of SIGNAL_PATTERNS) {
    if (pattern.test(title || '') || names.some((n) => lowerLabels.includes(n))) {
      return signal;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Position extraction for Rule 6 (contradictory linked decisions).
//
// The engine only compares EXPLICIT position statements, and this is
// where "explicit" is enforced: a statement counts only when a line
// names a subject and takes a stance via a decision verb in a fixed
// form — "Decision: use Postgres", "We will not use Redis",
// "Rejected: vendor lock-in". Free prose never becomes a position.
// ---------------------------------------------------------------------------

const POSITION_PATTERNS = [
  // "Decision: use X" / "Decided: adopt X"
  { re: /^\s*(?:decision|decided|approved)\s*:\s*(?:to\s+)?(use|adopt|keep|choose|allow)\s+(.+)$/i, stance: 'for', subjectGroup: 2 },
  // "Rejected: X" / "Decision: do not use X"
  { re: /^\s*(?:rejected|declined)\s*:\s*(.+)$/i, stance: 'against', subjectGroup: 1 },
  { re: /^\s*(?:decision|decided)\s*:\s*(?:do not|don't|never)\s+(?:use|adopt)\s+(.+)$/i, stance: 'against', subjectGroup: 1 },
  // "We will use X" / "We will not use X"
  { re: /^\s*we will (not\s+)?(?:use|adopt|keep|choose)\s+(.+)$/i, stanceFromGroup: 1, subjectGroup: 2 },
];

export function extractPositions(bodyText) {
  const positions = [];
  for (const rawLine of (bodyText || '').split('\n')) {
    const line = rawLine.trim();
    if (line.length < 6 || line.length > 200) {
      continue;
    }
    for (const p of POSITION_PATTERNS) {
      const match = line.match(p.re);
      if (!match) {
        continue;
      }
      const stance = p.stanceFromGroup
        ? match[p.stanceFromGroup]
          ? 'against'
          : 'for'
        : p.stance;
      const subject = match[p.subjectGroup].replace(/[.\s]+$/, '').trim();
      if (subject.length >= 2) {
        positions.push({ subject, stance, quote: line });
      }
      break; // one position per line
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Normalisation + REST operations
// ---------------------------------------------------------------------------

function normalisePage(raw, extras = {}) {
  const labels = ((raw.metadata && raw.metadata.labels && raw.metadata.labels.results) || []).map(
    (l) => String(l.name || '').toLowerCase(),
  );
  const bodyStorage = raw.body && raw.body.storage ? raw.body.storage.value : '';
  const bodyText = storageToText(bodyStorage);
  return {
    id: raw.id,
    title: raw.title || '',
    spaceKey: raw.space ? raw.space.key : extras.spaceKey || '',
    status: raw.status || 'current',
    version: raw.version ? raw.version.number : 0,
    statusSignal: detectStatusSignal(raw.title || '', labels),
    labels,
    bodyText,
    positions: extractPositions(bodyText),
    dueDate: extras.dueDate !== undefined ? extras.dueDate : null,
    _storage: bodyStorage,
  };
}

const PAGE_EXPAND = 'body.storage,metadata.labels,space,version';

/** Fetches one page by id, normalised for the rules engine. */
export async function getPage(pageId) {
  let raw;
  try {
    raw = await request(
      'GET',
      `/rest/api/content/${encodeURIComponent(pageId)}?expand=${PAGE_EXPAND}`,
    );
  } catch (primaryError) {
    // Some installs reject the direct content GET ("Authentication
    // Required") even though CQL search by the same user succeeds.
    // Fall back to a search by id — it returns the same expanded
    // shape, so callers keep reading the live page.
    const found = await searchPages(null, {
      cql: `id = ${pageId}`,
      maxTotal: 1,
    }).catch(() => []);
    if (!found.length) {
      throw primaryError;
    }
    const dueDate = await getPageProperty(pageId, 'rulebridge-duedate').catch(
      () => null,
    );
    return { ...found[0], dueDate };
  }
  const dueDate = await getPageProperty(pageId, 'rulebridge-duedate');
  return normalisePage(raw, { dueDate });
}

/** Reads one content property of a page (null when absent). */
export async function getPageProperty(pageId, key) {
  try {
    const raw = await request(
      'GET',
      `/rest/api/content/${encodeURIComponent(pageId)}/property/${encodeURIComponent(key)}`,
    );
    return raw && raw.value !== undefined ? raw.value : null;
  } catch (error) {
    if (error instanceof ConfluenceApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Searches pages in a space with CQL and returns them normalised.
 * The text body is included per page (a heavier search, bounded by
 * `maxTotal`), because the rules engine needs body text, not titles.
 */
export async function searchPages(spaceKey, { maxTotal = 50, cql } = {}) {
  const query = cql || `space="${spaceKey}" AND type=page ORDER BY lastmodified DESC`;
  const pages = [];
  let start = 0;
  while (pages.length < maxTotal) {
    const raw = await request(
      'GET',
      `/rest/api/content/search?cql=${encodeURIComponent(query)}` +
        `&start=${start}&limit=25&expand=${PAGE_EXPAND}`,
    );
    const batch = raw.results || [];
    for (const item of batch) {
      pages.push(normalisePage(item));
    }
    start += batch.length;
    if (batch.length === 0 || start >= (raw.totalSize || 0)) {
      break;
    }
  }
  return pages.slice(0, maxTotal);
}

/**
 * Resolves a page's explicitly-linked counterpart pages:
 * [{ id, title }]. Confluence's REST API has no cheap "outgoing links"
 * endpoint for content, so RuleBridge pairs pages two deterministic
 * ways instead: (1) the space scan pairs pages inside one search
 * result by shared position subjects (see fixes.scanSpace); (2) a team
 * can record explicit counterparts in the `rulebridge-links` content
 * property ({ linkedPageIds: [...] }), which this helper resolves.
 */
export async function getOutgoingLinks(pageId) {
  const stored = await getPageProperty(pageId, 'rulebridge-links');
  if (!stored || !Array.isArray(stored.linkedPageIds)) {
    return [];
  }
  const linked = [];
  for (const id of stored.linkedPageIds) {
    const page = await getPage(id);
    linked.push({ id: page.id, title: page.title });
  }
  return linked;
}

/** Adds a label to a page. Confluence answers 200 with the label. */
export async function addLabel(pageId, label) {
  await request('POST', `/rest/api/content/${encodeURIComponent(pageId)}/label`, [
    { prefix: 'global', name: label },
  ]);
}

/**
 * Prepends a storage-format block to a page body and bumps the page
 * version — the only body-writing primitive the fix executor uses.
 * The caller builds the block; this function performs the optimistic-
 * concurrency dance (fresh version read, then PUT with version+1).
 * `storageBody` of the CURRENT page must be supplied so the new body
 * is new-block + existing body, never a replacement.
 */
export async function prependToPage(pageId, storageBlock) {
  const raw = await request(
    'GET',
    `/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version`,
  );
  const currentBody = raw.body && raw.body.storage ? raw.body.storage.value : '';
  const nextVersion = (raw.version ? raw.version.number : 0) + 1;
  const updated = await request('PUT', `/rest/api/content/${encodeURIComponent(pageId)}`, {
    id: String(pageId),
    type: 'page',
    title: raw.title,
    version: { number: nextVersion, message: 'RuleBridge: applied a human-confirmed fix' },
    body: {
      storage: { value: `${storageBlock}${currentBody}`, representation: 'storage' },
    },
  });
  return { id: updated.id, version: updated.version ? updated.version.number : nextVersion };
}

/** Appends a row to a page's decision-log storage table fragment. */
export function escapeStorage(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
