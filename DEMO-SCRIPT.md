# Demo video script — RuleBridge (target ≤ 3:00)

Rules limits: under 5 minutes, public on YouTube, no third-party
trademarks or unlicensed music. This script runs ~2:45 at a calm pace.
Narration is written to be read aloud (or captioned verbatim).

**Setup before recording:** dev site with a demo Confluence space
`OPS` (Operations decisions) and these pre-created pages:
- "Q3 pricing — DECIDED" — body: the decision paragraph, an incomplete
  task "Maya Chen to confirm the discount ceiling", and the line
  "Open question: who owns the grandfathering exception?"
- "Vendor selection — APPROVED" — body with one completed task and one
  incomplete task that has a due date, so it stays clean for contrast
  (or reuse for the owner rule with a second incomplete, undated task)
- "Refund policy — FINAL" — body containing "The refund window is TBD
  for annual plans." and the label `draft`
- "Platform decision" — body containing the line "Decision: use Postgres"
- "Data review" — body containing the line "Rejected: Postgres"
- A handful of clean pages (honest drafts, finished policies) so the
  scan tables are believable. Rovo enabled on the site.

---

### Scene 1 — The lie (0:00–0:25)
**Screen:** The OPS space overview; slow pan over the page tree.
Titles read "— DECIDED", "— APPROVED", "— FINAL".
**Narration:** "This is a healthy-looking decision space. And it is
lying. This page says the pricing decision is *made* — but scroll
down and the body still holds an unanswered question and an open
action. Every decision page has two voices: the state it declares,
and what its body actually contains. When they drift apart, teams
execute decisions that were never really closed."

### Scene 2 — The verdict on the page (0:25–0:55)
**Screen:** Open "Q3 pricing — DECIDED". Under the title, the
RuleBridge byline item: warning verdict, findings for the open
question and the open action, fix buttons visible.
**Narration:** "RuleBridge checks the bridge between the two. Right
under the title, it compares what the page declares with what the
body holds. The verdict is unambiguous: this page calls itself
decided, but an open question and an open action say otherwise. And
notice — this is a deterministic rule engine, not an AI guess. Same
page, same verdict, every time."

### Scene 3 — One click repairs the record (0:55–1:20)
**Screen:** Click **Log this question in the decision log**. The page
reloads; a "RuleBridge decision log" block sits at the top listing
the open question, the owner, and "Due date: STILL MISSING". The
original body is visibly unchanged below it.
**Narration:** "Every finding comes with its repair. One click
inserts a decision log at the top of the page — the open question,
the named owner, and the missing date, made visible. RuleBridge
never rewrites a page's own words: every fix is an addition a human
asked for, or a review label. The body you wrote stays your body."

### Scene 4 — A "final" page that isn't (1:20–1:50)
**Screen:** Open "Refund policy — FINAL". Byline shows
final-with-placeholders (TBD) and draft-labeled-final findings.
Click **Flag this page as "needs review"**; show the label appearing.
**Narration:** "Sometimes the declaration itself is the problem.
This policy calls itself final — while it still contains a TBD, and
still carries its draft label. RuleBridge flags it for review
instead of pretending to fix prose: the page joins the team's queue,
labelled, until a human finishes it."

### Scene 5 — The whole space, ten seconds (1:50–2:15)
**Screen:** Space sidebar → RuleBridge space page. First table: the
remaining contradicting pages. Scroll to "Linked decisions in
conflict": Platform decision vs Data review on Postgres.
**Narration:** "Zoom out, and the space page lists every page that
contradicts itself — plus the pairs that contradict *each other*.
These two linked decisions state opposite positions on the same
subject. That rule is deliberately strict: it only fires on explicit
stance lines like these, never on a guess about prose."

### Scene 6 — The agent (2:15–2:40)
**Screen:** Rovo chat with the RuleBridge agent. Type: "Scan the OPS
space for contradicting decision records." Show the agent's summary.
Then: "Fix the contradiction on the pricing page." Show it naming
the fix, then reporting the result.
**Narration:** "And the same brain works in chat. The RuleBridge
Rovo agent checks pages, scans spaces and applies fixes — but
safely: before writing anything, the fix action re-runs the check
and only applies a repair the engine offers *right now*, and every
repair is additive. Agents propose; the engine disposes. The actions
are standard Forge actions, so any other agent can reuse them as
tools."

### Scene 7 — Close (2:40–2:50)
**Screen:** Back to "Q3 pricing — DECIDED" with its decision log on
top and the byline verdict visible.
**Narration:** "RuleBridge: deterministic contradiction detection
for Confluence — on the page, across the space, and inside Rovo. So
your decision record can stop lying."
**End card (text):** RuleBridge — Codegeist 2026 · Built on
Atlassian Forge (Confluence + Rovo)

---

**Recording notes**
- Keep each click deliberate; let panels finish loading before
  narrating over them.
- The task-list items must be real Confluence tasks (Insert → Action
  item), left incomplete — the storage-format checkbox state is what
  the engine reads; typed "[ ]" text in a paragraph also works in the
  demo because extraction is line-based, but real tasks are the
  honest demo.
- If Rovo is unavailable on the recording site, Scene 6 can be shot
  against the agent's conversation starters; do not fake agent
  output — if the agent cannot be recorded, drop Scene 6 and extend
  Scene 5 with the summary-draft fix on the pricing page instead.
