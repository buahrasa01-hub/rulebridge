---
name: rulebridge-contradiction-checker
description: Check whether a Confluence decision page contradicts itself, scan a whole space for contradicting decision records, and apply the additive fix the checker offers — use when a user asks whether a decision, meeting note, or policy page can be trusted as settled.
allowed-tools: check-page-contradictions fix-page-contradiction scan-space-contradictions
---

# RuleBridge contradiction checker

A Confluence decision page has two voices: the state it declares in
its title and labels ("DECIDED", "FINAL", "approved"), and what its
body actually contains. When they disagree — a page that calls itself
decided while its body still holds open questions or unowned actions
— teams act on a decision that was never really closed. This skill
finds that gap and, when asked, helps repair it with an additive fix
that never rewrites the page's own words.

Use this skill when the user asks whether a decision page, meeting
note, or policy page contradicts itself, wants a space scanned for
contradicting decision records, or wants a contradiction fixed. Do
not use it for anything else: it cannot write page content, edit
labels beyond the one review flag, or judge anything but the
declared-state-vs-body contradictions its tools report.

## Tools

All three tools are Forge actions of the RuleBridge app, exposed both
to Rovo agents and as MCP tools on the app's Rovo MCP server
(`rovo:mcp` module, server name "RuleBridge MCP"). They all run as
the invoking user, so the user's own Confluence permissions gate
every read and write.

### `check-page-contradictions` (read-only)

Input: `pageId` (the numeric Confluence page id, e.g. `123456`).
When the user is viewing a page, prefer that page's id; otherwise
ask for the id — never guess one.

Returns `ok`, the page's `title` and `declaredState` (decided /
final / approved / draft / proposed / null), a boolean `consistent`,
a one-line `verdict`, and `findings`. Each finding names the `rule`
that fired, the `claim` (the exact words), a one-sentence `message`,
and the `suggestedFix` on offer (a short label, or `null`).

How to report it: name the declared state first, then state the
verdict plainly. If there are findings, explain each in one sentence
and name the fix the checker offers. Never invent a page's declared
state, findings, or verdict — report only what the tool returned.
If it returns `ok: false`, relay the error and stop; do not guess a
workaround.

### `scan-space-contradictions` (read-only)

Input: `spaceKey` (e.g. `TEAM`).

Returns `ok`, `scanned` (how many pages were checked),
`flaggedCount`, `flagged` — each entry with `pageId`, `title`, and
the finding messages — and `pairs`: linked decision pages that
contradict each other on the same topic (each with `topic` and
`verdict`).

How to report it: summarise how many pages were scanned, how many
contradict themselves, and any linked pairs in conflict; list each
with its reason. A space with zero flagged pages is a clean bill of
health — say so, do not go looking for problems the scan did not
find.

### `fix-page-contradiction` (writes — confirm first)

Inputs: `pageId`, `fixKind` (`insert-decision-log`, `flag-page`, or
`draft-summary`).

Workflow — always in this order:

1. Run `check-page-contradictions` on the page first, so the offered
   fix is current. Only ever apply a fix kind the check offered for
   this page right now (`draft-summary` is the exception: it is
   always available, because it summarises whatever the current
   findings are).
2. Tell the user exactly which fix you are about to apply and wait
   for their confirmation whenever the conversation allows it. Never
   apply a fix the user did not ask for. Remind them of the product
   rule: RuleBridge fixes are additive only — the app never rewrites
   a page's own words.
3. Invoke the tool.
4. Report the result in substance: what changed, or why the fix could
   not be applied. The tool fails safely — `ok: false` with an
   explanation — when the requested fix is not currently offered.
   Relay that explanation; do not retry with a different fix kind
   unasked.

What each fix does:

- `insert-decision-log` — inserts a decision-log table at the top of
  the page recording the contradiction, the owner, and the still
  missing due date. The original body is unchanged below it.
- `flag-page` — adds the `needs-review` label to the page. The body
  is not touched at all; the page goes back into the team's review
  queue.
- `draft-summary` — drafts an unresolved-items summary block at the
  top of the page listing the current contradictions. The original
  body is unchanged below it.

## Rules

- Check before fixing, every time. A fix offered an hour ago may no
  longer be offered — the tool re-checks at invocation time and
  refuses stale fixes.
- One page at a time for fixes. A scan may list many contradicting
  pages, but each fix is confirmed per page.
- Never propose rewriting a page's body text to "fix" a
  contradiction. If no offered fix fits what the user wants, say so
  and let a human edit the page.
- If any tool returns an error, relay it and stop. Never invent a
  workaround that writes data.
