# Build log — RuleBridge

Newest first. Direction decisions are Bayu's; implementation is built
with Muse as his coding tool under that direction (see README,
"Direction & ownership").

## 2026-11-09 — Full local build (no accounts yet)

Direction for the day (Bayu): garap everything one by one,
Codegeist first; after IncidentBridge (entry #1, Software Teams),
build the portfolio's second entry — RuleBridge (Business Teams,
Confluence) — as far as possible without any Atlassian/Devpost
account. Distinctness from entry #1 is a rules requirement ("unique
and substantially different"): different product (Confluence vs
Jira), different data (page declaration-vs-body vs summary-vs-status),
different rules, different surfaces, different fixes. The shared DNA
is only the architecture pattern (pure engine + mockable seam + DI
fix executor), which is a build method, not a copied product.

Done:
- **Verification first**: module keys (`confluence:contentBylineItem`,
  `confluence:contentAction`, `confluence:spacePage`), the spacePage
  `route` property, and the granular Confluence scopes
  (`read:page:confluence`, `write:page:confluence`,
  `read/write:content.property:confluence`, `write:label:confluence`,
  `search:confluence`) were all read from Atlassian's current Forge
  manifest reference + Confluence scopes page on 2026-11-09 before
  the manifest was written.
- **Scaffold**: from Atlassian's official
  `confluence-content-action-ui-kit` + `confluence-space-page-ui-kit`
  template zips (fetched anonymously; `forge create` needs login).
  `manifest.template-original.yml` keeps the content-action
  template's manifest; `AGENTS.md` is the templates' Forge guidance.
  Dependencies pinned to entry #1's exact versions so both entries
  behave identically under Forge CLI 15.0.0.
- **Engine** (`src/lib/decisionRules.js`): 6 deterministic rules —
  decided-but-open-questions, decided-but-open-actions,
  owner-without-due-date, final-with-placeholders,
  draft-labeled-final, contradictory-linked-decisions. Findings carry
  a fix descriptor; the result contract mirrors entry #1's shape
  (consistent/findings/verdict + primary shortcuts).
- **API seam** (`src/lib/confluenceClient.js`): all Confluence REST
  behind one lazy-loaded `asUser().requestConfluence()` transport
  with `setTransportForTests()` injection; storage-format→text
  extraction that preserves task checkbox state (the rules' key
  evidence); the fixed declared-state signal table; explicit-position
  extraction for Rule 6; content-property reads for the page-level
  due date and explicit link records.
- **Fix executor** (`src/lib/fixes.js`): decision-log insert
  (prepends a labelled info-macro table; original body preserved
  verbatim — optimistic version bump handled in the client),
  flag-page (`needs-review` label, idempotent), draft-summary
  (recomputes current findings and prepends the summary block), and
  the bounded space scan with subject-based Rule-6 pairing.
- **Resolvers** (`src/resolvers/index.js`): `analyzePage` reads the
  real page from view context with a labelled fixture fallback;
  `applyFix` executes one chosen fix; `scanSpace` powers the space
  page.
- **Surfaces**: byline item + content action sharing
  `src/frontend/index.jsx` (verdict, per-finding explanations, fix
  buttons, post-fix re-check, honest "Demo data" banner), and the
  space page `src/frontend/space.jsx` (two DynamicTables: page
  contradictions + linked pairs in conflict; EmptyState when the
  record is truthful).
- **Rovo variant** (`rovo:agent` + 3 `action` modules; handlers in
  `src/rovo.js`): agent prompt with three jobs (check / scan / fix)
  and honesty rules; fix action re-derives the offered fix from the
  page's current state before writing. Ships in the same manifest —
  this is what makes the Best Agents bonus angle feasible (see
  DEVPOST.md); the primary bonus write-up is Marketplace.
- **Tests**: 44 node:test cases (engine rules × consistent/
  inconsistent for all six rules, client over a fake transport incl.
  storage extraction and position extraction, executor incl.
  additive-write order) — all passing via `npm test`. Two test-side
  bugs found and fixed during the run (a fake-transport route-order
  collision between the page GET and its property GET; a shadowed
  helper name in the pair test) — the suite caught both before any
  source change was needed.
- **Checks**: ESLint clean; `forge lint` reports only the expected
  missing `app.id` (registration step, post-login).
- **Submission drafts**: `DEVPOST.md` (title, tagline, full
  description, category + both bonus write-ups, judge testing
  instructions) and `DEMO-SCRIPT.md` (7 scenes, ~2:45, with narration
  and recording setup).

Queued (blocked on Bayu's Atlassian account, exact commands in
README "Next steps"): `forge login` → `forge register` → `forge lint`
(expect clean) → `forge deploy` → `forge install` (confluence) → live
run of the judging script → installation link → video → Marketplace
listing submission → Devpost filing before 2026-12-23 03:00 WIB.

Human sanity-check items recorded in README "Design decisions":
declared-state signal table, additive-only fix philosophy, Rule 6
conservatism, explicit pairing model.
