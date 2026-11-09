# Devpost submission draft — RuleBridge

> Draft for the Codegeist 2026 "Enter a Submission" form. All fields in
> English (submission requirement). Bracketed items are filled in after
> Bayu's accounts exist (installation link, video URL).

## Title

RuleBridge

## Tagline

Your decision record is lying to you — RuleBridge catches Confluence pages that declare themselves decided, final or approved while their own bodies disagree, and repairs the record in one click.

## Project description

### The problem

Every Confluence decision page speaks with two voices. The
**declaration** — "DECIDED" in the title, a "Final" policy, an
"Approved" label — is what everyone trusts and acts on. The **body**
is what the team actually left behind. Over a page's life the two
voices quietly drift apart:

- "Q3 pricing — DECIDED" — with an **open question** still sitting in
  the body, unanswered.
- "Vendor selection — APPROVED" — with **action items still
  unchecked**, including one naming an owner and **no due date**.
- "Refund policy — FINAL" — still containing **TBD** and a TODO.
- A page titled "FINAL" that still carries the **draft** label.
- Two linked decision pages that **state opposite positions** on the
  same subject — "Decision: use Postgres" on one, "Rejected:
  Postgres" on the other.

No tool warns about any of this, because every reader trusts the
declaration. The result is not a crash — it is decisions being
executed that were never really closed, policies being quoted that
were never really finished, and follow-ups with an owner but no date
that simply evaporate. It is the broken bridge between what a team
*recorded* and what is actually *true*.

### The solution

**RuleBridge** is a Forge app that checks the bridge between a page's
declaration and its body:

1. **Deterministic rules engine.** A pure-function engine compares
   what a page *declares* (title + label signal, mapped by a small
   fixed table) against what its body *contains*. Six defensible
   rules: decided-but-open-questions, decided-but-open-actions,
   owner-without-due-date, final-with-placeholders,
   draft-labeled-final, and contradictory-linked-decisions. No LLM,
   no guessing: the same page always produces the same verdict, which
   is exactly what a trust tool needs. The cross-page rule is
   deliberately the most conservative: it fires only on explicit,
   opposite stance statements ("Decision: use X" vs "Rejected: X")
   about the exact same subject — free prose never becomes a
   "position", because a false accusation is the worst output this
   tool can produce.

2. **A verdict where the work happens.** A **content byline item**
   under every page title shows the verdict on the page itself, with
   every finding explained in one sentence — and the fix attached.
   The same check is one click away in the page's **content action**
   menu for a full modal view.

3. **One-click fixes, human-confirmed — and additive only.** A page
   body is prose a team owns; there is no safe silent rewrite. So
   every finding offers its honest repair, executed only on an
   explicit click:
   - *Insert a decision-log table* at the page top recording the open
     question/action, the named owner, and the missing due date —
     implicit loose ends become visible, tracked work;
   - *Flag the page* with a `needs-review` label — the page joins the
     review queue; the body is not touched at all;
   - *Draft an unresolved-items summary* at the page top, generated
     from the current findings, inside a labelled macro block.
   In every case the original body is preserved verbatim below the
   inserted block; nothing is ever silently rewritten.

4. **A space-wide contradiction scan.** A **space page** lists every
   self-contradicting page in the space in one table, plus a second
   table for linked decision pairs that contradict each other — the
   ten-second truth check a lead runs before a steering meeting.

5. **The same brain, as a Rovo agent.** RuleBridge ships a
   **Rovo agent** plus three reusable **actions**
   (`check-page-contradictions`, `fix-page-contradiction`,
   `scan-space-contradictions`). Ask in chat: *"Scan the OPS space
   for contradicting decision records"* or *"Fix the contradiction on
   this page"*. Because the actions are standard Forge actions, **any
   other agent** — including customer-built ones — can invoke the same
   check as a tool. The fix action is safe by construction: it re-runs
   the check and only applies a fix the engine currently offers, so a
   stale or hallucinated request fails safely instead of writing.

### How it is built (Forge modules used)

| Surface | Forge module | What it does |
|---|---|---|
| Byline item | `confluence:contentBylineItem` (UI Kit) | Verdict + findings + fix buttons under the page title |
| Content action | `confluence:contentAction` (UI Kit) | The same check/fixes as a modal from the page ••• menu |
| Space page | `confluence:spacePage` (UI Kit) | Whole-space contradiction tables (DynamicTable) |
| Agent | `rovo:agent` | RuleBridge agent with three jobs: check, scan, fix |
| Agent tools | `action` × 3 | check-page-contradictions (GET), fix-page-contradiction (UPDATE), scan-space-contradictions (GET) |
| Backend | `function` (resolvers + action handlers) | Shared engine, fix executor, REST client |

All product calls go through one client
(`src/lib/confluenceClient.js`) using
`api.asUser().requestConfluence(...)`, so Confluence's own permission
checks gate every read and write; the app never acts with broader
rights than the person using it. Storage-format bodies are flattened
to text deterministically in the client (task lists keep their
checkbox state — that state is evidence the rules read). The engine
(`src/lib/decisionRules.js`) is a pure module with a 44-case test
suite (rules, REST client over a fake transport, fix executor) that
runs with `npm test` — no site needed.

### Why this matters

Decision records are the memory of a business team. When the memory
declares "decided" over an unanswered question, or "final" over a
TBD, the organisation acts on fiction — politely, confidently, and
at scale. RuleBridge makes that gap visible at the moment and place
it can be fixed — on the page, across the space, or in a chat with an
agent — and removes the toil of repairing it. It is deliberately
deterministic: teams will only trust an automated consistency
checker if it never cries wolf, and every rule here can be explained
in one sentence.

## Category

**Apps for Business Teams**

## Bonus prize write-ups

### Best Marketplace published app

RuleBridge is built to Marketplace standards from day one: a single
deterministic engine with a real test suite, minimal granular scopes
(`read/write:page:confluence`, `read/write:content.property:confluence`,
`write:label:confluence`, `search:confluence`), asUser permission
discipline, fixes that are additive and human-confirmed by design,
and a use case every Confluence customer recognises — decision
hygiene. [Marketplace listing / review-ticket link: INSERT after
submission for listing.] The app runs consistently when installed
from its sharing link, and this Devpost page documents the full
testing instructions a reviewer or judge needs.

### Best Agents (Rovo)

RuleBridge is agent-native in both directions. It **ships an
agent**: a `rovo:agent` whose prompt defines three jobs (check one
page, scan a space, fix a contradiction with confirmation) and strict
honesty rules — it may only report what its actions return, and must
relay action errors instead of inventing workarounds. And it **feeds
other agents**: its three `action` modules are reusable tools any
Rovo agent can call, including agents customers build themselves.
The safety design is the point: `fix-page-contradiction` re-derives
the offered fix from the page's *current* state at invocation time,
so an agent can never apply a repair the deterministic checker has
not just approved — and every repair it can apply is additive.
Agents propose; the engine disposes.

## Testing / configuration instructions for judges

No configuration, API keys or external services are required.

1. Open the installation link: [INSERT INSTALLATION LINK] and install
   RuleBridge into a Confluence Cloud site.
2. In any space, create these pages to see each rule fire:
   - Title `Q3 pricing — DECIDED`, body containing a line
     `Open question: who owns the grandfathering exception?` → open
     the page; the RuleBridge byline item reports a
     decided-but-open-questions finding and offers **Log this question
     in the decision log**. Click it: a decision-log table appears at
     the top of the page; the original body is unchanged below it.
   - Title `Vendor selection — APPROVED`, body containing an
     unchecked task `- [ ] Maya Chen to confirm the discount ceiling`
     (a Confluence task list item, left incomplete) → findings for
     open actions and for the owner with no due date.
   - Title `Refund policy — FINAL`, body containing `The refund
     window is TBD for annual plans.` → final-with-placeholders;
     offered fix flags the page `needs-review`.
   - Any page titled with `FINAL` that also carries the label
     `draft` → draft-labeled-final.
   - Two pages, one containing the line `Decision: use Postgres`,
     the other `Rejected: Postgres` → the space scan's "Linked
     decisions in conflict" table lists the pair.
3. Open the space's **RuleBridge page** (space sidebar) to see the
   whole-space contradiction tables.
4. In Rovo chat, select the **RuleBridge** agent (or use the
   conversation starters): ask it to check the page from step 2, to
   scan the space, then to fix the contradiction on the first page.
   It will name the fix before applying it and report the result.

## How it meets the main technology requirement

RuleBridge is a new app built entirely on **Atlassian Forge**: it has
a Forge manifest with seven module types
(`confluence:contentBylineItem`, `confluence:contentAction`,
`confluence:spacePage`, `rovo:agent`, `action`, plus `function`
backends and UI Kit resources), integrates **Confluence** (page
reads, CQL search, labels, content properties, additive page writes)
and **Rovo** (a shipped agent plus reusable actions). All logic runs
in Forge functions; the frontend is pure UI Kit (`@forge/react`).

## Built with

Atlassian Forge · Forge UI Kit (@forge/react) · @forge/api ·
@forge/resolver · @forge/bridge · Rovo (agent + actions) ·
Confluence Cloud REST API · Node.js 24

## Links

- Installation link: [INSERT]
- Demo video (YouTube, public): [INSERT]
- Source repository: [INSERT if published]
