// ---------------------------------------------------------------------------
// RuleBridge — Teamwork Graph client (the mockable seam)
//
// What this is: Teamwork Graph is Atlassian's connected model of a site
// — users, teams, Jira work items, Confluence pages, goals, and whatever
// else links into them. This module reads it through the GraphQL
// endpoint
//   POST https://<site>.atlassian.net/gateway/api/graphql/twg
// using one CURATED query — a typed root field maintained by
// Atlassian, no Cypher text sent at request time (raw `cypherQuery`
// is unavailable to new apps):
//
//   * confluencePageLinkedConfluencePages(id) — pages linked FROM the
//     page being checked (read:graph:page:confluence)
//
// Why this one field: RuleBridge already has a Rule 6
// (contradictory-linked-decisions) but, until now, it could only pair
// pages that happen to sit in the same space scan, or pages a team
// recorded by hand in the `rulebridge-links` content property. The
// graph IS the real link structure — a decision page that links to
// another decision page, wherever it lives — so this query is what
// makes Rule 6 run on the links teams actually made. Each linked page
// comes back with its title and storage body, so the existing
// position extractor and pair rule run over graph data unchanged.
//
// What this is NOT: a write path. Every Teamwork Graph scope is
// read-only — "there is no write access to the graph through this
// API" (Scopes reference). RuleBridge therefore only READS the graph;
// contradictions are still fixed through the Confluence REST API, as
// before. Page owners are deliberately NOT fetched: the owner query
// would need AtlassianUser fields whose GraphQL shape the reference
// does not document, and guessing a field would break the query.
//
// Auth: the live transport is @forge/api's
// `api.asUser().requestTeamworkGraph(...)`, so the graph enforces the
// viewing user's permissions on top of the scopes, exactly like the
// Confluence client. @forge/api is imported lazily, only when a live
// request is actually made, so importing this module (e.g. from the
// test suite) never requires the Forge runtime.
//
// Tests inject a transport with setTransportForTests() — the same seam
// pattern as src/lib/confluenceClient.js. The fake receives (query,
// variables) and returns the parsed GraphQL body { data, errors }.
//
// ARIs: the curated query takes an object ARI as `id`. A Confluence
// page ARI is `ari:cloud:confluence:{cloudId}:page/{pageId}` (the
// numeric content id RuleBridge already uses as `page.id`). The
// cloudId comes from the Forge invocation context
// (`req.context.cloudId` in resolvers, `context.cloudId` in Rovo
// actions). When either piece is missing the module says so
// ({ available: false }) instead of guessing an ARI — callers then
// answer from the page-local rules alone and label the graph as
// unavailable.
//
// Two documented behaviours callers must know:
//   * A missing/ungranted scope produces NO error: the field just
//     comes back empty. An empty linked-pages list therefore means
//     "no linked pages visible to this user under the granted scope",
//     never "the page links to nothing". The code never treats
//     absence as proof of anything.
//   * Curated queries cap `first` at 25; 25 linked pages is the most
//     the field returns in one call.
//
// Operation names follow the documented `company_operation` shape
// (e.g. `rulebridge_linkedPages`).
//
// Docs (all developer.atlassian.com, read 2026-11-25):
//   * Call the Teamwork Graph API —
//     /platform/teamwork-graph/call-the-teamwork-graph-api/
//   * Curated queries —
//     /platform/teamwork-graph/curated-queries/
//   * Scopes — /platform/teamwork-graph/scopes/
//   * Object type: ConfluencePage —
//     /platform/teamwork-graph/api-reference/object-types/ConfluencePage/
//   * Understanding ARIs —
//     /platform/teamwork-graph/understanding-aris/
// ---------------------------------------------------------------------------

import { checkLinkedPair } from './decisionRules.js';
import {
  storageToText,
  extractPositions,
  detectStatusSignal,
} from './confluenceClient.js';

let injectedTransport = null;

/**
 * Test seam: replace the live transport with a fake.
 * The fake receives (query, variables) and must return the parsed
 * GraphQL response body { data, errors }. Pass null to restore the
 * live transport.
 */
export function setTransportForTests(transport) {
  injectedTransport = transport;
}

/** Error type for Teamwork Graph failures (transport or GraphQL). */
export class TeamworkGraphError extends Error {
  constructor(message, graphQLErrors) {
    super(message);
    this.name = 'TeamworkGraphError';
    this.graphQLErrors = graphQLErrors || null;
  }
}

/**
 * Builds a Confluence page ARI from the site's cloudId and the
 * page's numeric content id, or null when either piece is missing.
 * Never guesses.
 */
export function buildPageAri(cloudId, pageId) {
  const cloud = String(cloudId || '').trim();
  const id = String(pageId || '').trim();
  if (!cloud || !id) {
    return null;
  }
  return `ari:cloud:confluence:${cloud}:page/${id}`;
}

// One curated field. The selection uses only fields listed on the
// ConfluencePage reference: id, pageId, title, space { key },
// content { storage { value } }. Labels are not selected — the graph
// does not expose them on this type — so a linked page's declared
// state is detected from its title only (see parseLinkedPages).
export const LINKED_PAGES_QUERY = `
query rulebridge_linkedPages($id: ID!) {
  confluencePageLinkedConfluencePages(id: $id, first: 25) {
    edges {
      node {
        ... on ConfluencePage {
          id
          pageId
          title
          space {
            key
          }
          content {
            storage {
              value
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const OPERATION_NAME = 'rulebridge_linkedPages';

async function requestGraph(query, variables) {
  if (injectedTransport) {
    return injectedTransport(query, variables);
  }
  // Live transport — lazy import so plain-Node tests never load Forge.
  const apiModule = await import('@forge/api');
  // Interop guard (same bundler-wrapping concern as confluenceClient):
  // use whichever module level actually exposes asUser().
  const api = [apiModule, apiModule.default, apiModule.default?.default]
    .find((candidate) => candidate && typeof candidate.asUser === 'function');
  const response = await api
    .asUser()
    .requestTeamworkGraph(query, variables, OPERATION_NAME);
  return response.json();
}

// Pulls the node objects out of a Relay connection, tolerating the
// shape a partially-granted query produces (a field the admin did
// not grant comes back absent, not erroring).
function connectionNodes(data, field) {
  const connection = (data && data[field]) || {};
  const edges = Array.isArray(connection.edges) ? connection.edges : [];
  return edges.map((edge) => (edge && edge.node) || null).filter(Boolean);
}

/**
 * Normalises linked pages from a raw GraphQL response into the
 * shape the rules engine reads:
 *   {
 *     id,            // numeric Confluence content id (pageId)
 *     title, spaceKey,
 *     bodyText,      // plain text from the graph's storage body
 *     positions,     // explicit position statements (Rule 6 input)
 *     statusSignal,  // from the title only — labels are not in the
 *                     // graph selection, so a label-declared state
 *                     // on a linked page is not visible here
 *   }
 * Unknown/missing pieces become empty values — never a throw.
 */
export function parseLinkedPages(data) {
  return connectionNodes(data, 'confluencePageLinkedConfluencePages')
    .map((node) => {
      const title = node.title || '';
      const bodyText = storageToText(
        (node.content && node.content.storage && node.content.storage.value) || '',
      );
      return {
        id: node.pageId || node.id || null,
        title,
        spaceKey: (node.space && node.space.key) || '',
        bodyText,
        positions: extractPositions(bodyText),
        statusSignal: detectStatusSignal(title, []),
      };
    });
}

/**
 * Fetches the pages linked from one page, via the graph.
 * @returns {Promise<{available, reason?, pages}>}
 *   `available: false` (with `reason`) when the ARI cannot be built —
 *   no request is sent. GraphQL `errors` or a transport failure
 *   throws TeamworkGraphError; callers degrade to the page-local
 *   rules and label the graph unavailable.
 */
export async function getLinkedPages({ cloudId, pageId }) {
  const ari = buildPageAri(cloudId, pageId);
  if (!ari) {
    return { available: false, reason: 'missing-cloud-id-or-page-id', pages: [] };
  }
  const body = await requestGraph(LINKED_PAGES_QUERY, { id: ari });
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const detail = body.errors.map((e) => e.message || JSON.stringify(e)).join('; ');
    throw new TeamworkGraphError(`Teamwork Graph query failed: ${detail}`, body.errors);
  }
  return { available: true, pages: parseLinkedPages(body && body.data) };
}

/**
 * Runs the existing Rule 6 pair rule between the checked page and
 * each graph-linked page (pure — no network). Returns only the pairs
 * that actually contradict, as:
 *   [{ linkedPageId, linkedTitle, findings, verdict }]
 * Agreement, or a linked page with no explicit position on a shared
 * subject, produces no entry — the pair rule itself decides.
 */
export function findGraphPairs(page, linkedPages) {
  const pairs = [];
  for (const linked of linkedPages || []) {
    if (!linked || String(linked.id) === String(page.id)) {
      continue; // never pair a page with itself
    }
    const result = checkLinkedPair({ a: page, b: linked });
    if (result.findings.length > 0) {
      pairs.push({
        linkedPageId: linked.id,
        linkedTitle: linked.title || '',
        findings: result.findings,
        verdict: result.verdict,
      });
    }
  }
  return pairs;
}

// Mirrors the verdict wording of decisionRules.js buildResult(), so a
// graph-enriched result reads exactly like a page-local result.
function rebuildVerdict(findings) {
  if (findings.length === 0) {
    return 'The page says what it means — no contradictions detected.';
  }
  const primary = findings[0];
  return findings.length === 1
    ? primary.message
    : `${findings.length} contradictions detected. First: ${primary.message}`;
}

const SUGGESTED_ACTION_BY_FIX_KIND = {
  'insert-decision-log': 'offer-decision-log',
  'flag-page': 'offer-flag-page',
  'draft-summary': 'offer-summary-draft',
};

/**
 * Merges graph pair findings into a checkPage result (pure — no
 * network). Graph findings are appended AFTER the page-local ones,
 * so the page-local primary finding (and its shortcuts) never moves
 * — unless the page is locally clean and the graph is the only voice,
 * in which case the shortcuts follow the graph finding.
 *
 * The returned object is the check result plus a `graphPairs` list
 * the byline item and the Rovo action pass through verbatim.
 */
export function mergeGraphPairs(check, pairResults) {
  const graphFindings = (pairResults || []).flatMap((p) => p.findings || []);
  const findings = [...(check.findings || []), ...graphFindings];
  const primary = findings[0] || null;
  return {
    ...check,
    consistent: findings.length === 0,
    findings,
    verdict: rebuildVerdict(findings),
    primaryRule: primary ? primary.rule : null,
    suggestedAction:
      primary && primary.fix
        ? SUGGESTED_ACTION_BY_FIX_KIND[primary.fix.kind] || null
        : null,
    graphPairs: pairResults || [],
  };
}
