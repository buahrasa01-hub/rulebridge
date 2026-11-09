# RuleBridge

**Codegeist 2026 entry #2 — Category: Apps for Business Teams.**
Bonus targets: **Best Marketplace published app** (primary write-up)
and **Best Agents (Rovo)** — the manifest ships a `rovo:agent` plus
three reusable `action` modules alongside the Confluence surfaces, so
the agent variant is real, not aspirational. (One Grand + one Bonus
is the maximum a single submission can win; both write-ups are
drafted in `DEVPOST.md`.)

**Pitch:** Confluence decision records and meeting notes declare a
state — DECIDED in the title, "Final" policy, "Approved" in a label —
and then quietly contradict it in the body: open questions never
answered, action items with an owner but no date, TBD placeholders in
a "final" policy, a linked decision page that says the opposite.
RuleBridge checks the declaration against the body with a
deterministic rule engine, shows the verdict where the work happens
(content byline, page actions, space-wide scan, Rovo chat), and
offers one-click, human-confirmed, **additive-only** fixes for every
finding.

**Direction & ownership:** This project is entered by **Bayu Luqman
Fadilah** (solo entrant, Indonesia), who directs the project: he chose
the competition and the portfolio order, set the product direction
(a deterministic checker, not an LLM guesser; fixes only on explicit
human confirmation; page bodies never silently rewritten), and owns
the Atlassian/Devpost accounts, the deployment, and the final
submission. Implementation work is carried out with an AI coding
assistant (Muse) acting as his build tool, under his direction;
design decisions, prompts and review checkpoints are recorded in
this repository (`BUILD-LOG.md`, `../PREP.md`) so the entrant can
describe and defend every part of the submission as his own work
product.

## What is built

| Piece | File(s) | State |
|---|---|---|
| Decision rules engine (6 rules, pure, deterministic) | `src/lib/decisionRules.js` | ✅ done, tested |
| Confluence API client (single mockable seam, asUser; storage→text, signal + position extraction) | `src/lib/confluenceClient.js` | ✅ done, tested |
| Fix executor (decision log / flag label / summary draft) + space scan with Rule-6 pairing | `src/lib/fixes.js` | ✅ done, tested |
| Byline/action backend (analyzePage, applyFix, scanSpace resolvers) | `src/resolvers/index.js` | ✅ done |
| Byline item + content-action UI (verdict, findings, fix buttons) | `src/frontend/index.jsx` | ✅ done |
| Space page UI (contradiction tables) | `src/frontend/space.jsx` | ✅ done |
| Rovo agent + 3 actions (check / fix / scan) | `manifest.yml`, `src/rovo.js` | ✅ done |
| Test suite — 44 tests, `npm test` | `test/` | ✅ passing |
| Devpost text + demo script | `DEVPOST.md`, `DEMO-SCRIPT.md` | ✅ drafted |

Checks at last build (2026-11-09): `npm test` 44/44 pass; ESLint clean
(`npm run lint`); `forge lint` reports **only** the expected
"app must have required property 'id'" — the manifest has no `app.id`
until `forge register` stamps a real one after login. **Do not invent
an id.**

## Design decisions (the ones a judge — or Bayu — should sanity-check)

1. **Declared state is a signal, not a status field.** Confluence has
   no workflow status for pages, so the engine tests the page's own
   declaration: title wording + labels, mapped by the client's fixed
   `detectStatusSignal` table (decided > final > approved > proposed
   > draft). The mapping is small, documented, and deterministic —
   the same honesty standard as entry #1's status categories.
2. **Deterministic over clever.** Six narrow rules, each explainable
   in one sentence. Rule 6 (contradictory linked decisions) is the
   most conservative rule in either entry: it fires only on explicit,
   opposite stance statements ("Decision: use X" vs "Rejected: X")
   about the exact same subject, extracted by fixed patterns — free
   prose never becomes a "position". A false accusation of
   self-contradiction is the worst output this tool can produce, so
   the rule would rather miss than guess.
3. **Fixes are additive, never rewrites.** Confluence bodies are
   prose people own; there is no safe automatic edit. Every fix is a
   visible addition the human asked for: a decision-log table or an
   unresolved-items summary inserted at the page top inside a labelled
   info macro (original body preserved verbatim below), or a
   `needs-review` label. Nothing is ever silently rewritten.
4. **Fixes are explicit and re-validated.** Nothing writes
   automatically. The Rovo fix action re-runs the check at invocation
   time and only applies a fix the engine currently offers.
5. **asUser everywhere.** No `asApp()` calls; Confluence's own
   permissions gate every read/write. Minimal granular scopes:
   `read/write:page:confluence`, `read/write:content.property:confluence`,
   `write:label:confluence`, `search:confluence`.
6. **Pairing is explicit, not topological.** Confluence REST has no
   cheap outgoing-links endpoint, so Rule 6 pairs pages two
   deterministic ways: pages in one space scan that state positions
   on the same subject, and explicit counterparts recorded in the
   `rulebridge-links` content property.
7. **Fixture fallback is labelled.** Before the app is deployed, the
   byline answers from a demo fixture and displays a "Demo data"
   banner (`source: 'fixture'`) rather than pretending to read a live
   page.

## Layout

```
manifest.yml              Forge modules: contentBylineItem,
                          contentAction, spacePage, rovo:agent,
                          3× action, functions, scopes
src/index.js              Function entry (resolver handler)
src/resolvers/index.js    Byline/action/space-page backend
src/rovo.js               Rovo action handlers
src/lib/decisionRules.js  The engine (pure — read this first)
src/lib/confluenceClient.js REST client + setTransportForTests seam
src/lib/fixes.js          Fix executor + space scan (DI over client)
src/frontend/index.jsx    Byline item / content action UI (UI Kit)
src/frontend/space.jsx    Space page UI (UI Kit only)
test/                     node:test suites (engine, client, executor)
DEVPOST.md                Submission text (draft)
DEMO-SCRIPT.md            ≤3-minute demo video script
BUILD-LOG.md              What was done, when, and what is queued
```

## Commands

```sh
npm test          # 44 tests, plain Node, no site needed
npm run lint      # ESLint over src/
export LD_PRELOAD=/tmp/no_chown.so   # VM quirk, see below
forge lint        # expect ONLY the app.id error until registration
```

## Next steps — blocked on Bayu's Atlassian account (exact queue)

```sh
# On the VM, in this directory, with the LD_PRELOAD shim loaded:
forge login        # Bayu's Atlassian email + API token (his hand)
forge register     # stamps the real app.id into manifest.yml
forge lint         # expect: zero errors
forge deploy --non-interactive
forge install --non-interactive --site <dev-site> --product confluence
```

Then: run the DEVPOST.md judging script live on the dev site, record
the video per DEMO-SCRIPT.md, create the Forge installation link,
(optionally) submit the Marketplace listing early for the bonus, and
file the Devpost submission **before 2026-12-23 03:00 WIB**.

## Provenance & VM quirks

- Scaffolded 2026-11-09 from Atlassian's official
  `confluence-content-action-ui-kit` and `confluence-space-page-ui-kit`
  templates (MIT). The template zips were fetched from Atlassian's
  public template service because `forge create` itself requires a
  logged-in account (it registers the app server-side).
  `manifest.template-original.yml` keeps the pristine content-action
  template manifest for diffing; `AGENTS.md` in this directory is the
  templates' Forge coding guidance and governs work here. Module and
  scope names were verified against Atlassian's Forge manifest
  reference and the Confluence granular-scopes page on 2026-11-09.
- Dependencies are pinned to the exact versions entry #1
  (IncidentBridge) builds against (@forge/api ^8.5.0,
  @forge/react 12.4.0-next.3, …) so both entries behave identically
  under the same Forge CLI.
- Forge CLI 15.0.0 lives at
  `~/workspace/tools/forge/node_modules/.bin/forge` (installed with
  `--ignore-scripts`; the native keytar build fails on this VM for
  lack of libsecret, and keytar is optional).
- The VM forbids `chown`, which crashes the CLI's config writer.
  Shim (`/tmp` does not survive VM replacement — rebuild when forge
  dies with EPERM):
  ```sh
  cat > /tmp/no_chown.c <<'C'
  #define _GNU_SOURCE
  #include <sys/types.h>
  #include <unistd.h>
  int chown(const char*p,uid_t o,gid_t g){(void)p;(void)o;(void)g;return 0;}
  int lchown(const char*p,uid_t o,gid_t g){(void)p;(void)o;(void)g;return 0;}
  int fchown(int f,uid_t o,gid_t g){(void)f;(void)o;(void)g;return 0;}
  int fchownat(int d,const char*p,uid_t o,gid_t g,int fl){(void)d;(void)p;(void)o;(void)g;(void)fl;return 0;}
  C
  cc -shared -fPIC -o /tmp/no_chown.so /tmp/no_chown.c
  ```
- Per fresh HOME, run once:
  `forge settings set usage-analytics false` (otherwise the CLI blocks
  on an interactive analytics prompt in non-TTY shells).
