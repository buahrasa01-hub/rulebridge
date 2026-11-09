import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

// ---------------------------------------------------------------------------
// RuleBridge — Confluence content byline item (+ content action modal)
//
// Lives in the byline under every page title: the page declares a
// state (DECIDED / FINAL / APPROVED); RuleBridge checks whether the
// body backs that declaration up. The resolver (`analyzePage`) runs
// the shared rules engine; this UI renders every finding and offers
// the fix attached to it.
//
// Fixes are applied only when the user presses a fix button
// (`applyFix` resolver). After a fix, the page is re-checked so what
// is on screen always reflects the page's real state. A separate
// button drafts the unresolved-items summary at the page top.
// All fixes are additive and labelled — the existing body is never
// silently rewritten (see src/lib/fixes.js).
// ---------------------------------------------------------------------------

const App = () => {
  const [result, setResult] = useState(null);
  const [pageId, setPageId] = useState(null);
  const [notice, setNotice] = useState(null); // { appearance, text }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id) => {
    const data = await invoke('analyzePage', id ? { pageId: id } : {});
    setResult(data);
  }, []);

  useEffect(() => {
    // The page id comes deterministically from the view context —
    // never from user input — so the check always targets the page
    // on screen.
    view
      .getContext()
      .then((ctx) => {
        const id =
          ctx && ctx.extension && ctx.extension.content ? ctx.extension.content.id : null;
        setPageId(id);
        return load(id);
      })
      .catch(() => load(null));
  }, [load]);

  const applyFix = async (fix) => {
    setBusy(true);
    setNotice(null);
    const outcome = await invoke('applyFix', { pageId, fix });
    setBusy(false);
    setNotice({
      appearance: outcome.applied ? 'success' : 'warning',
      text: outcome.detail,
    });
    if (outcome.applied) {
      await load(pageId); // re-check so the verdict reflects reality
    }
  };

  const draftSummary = async () => {
    setBusy(true);
    setNotice(null);
    const outcome = await invoke('applyFix', { pageId, fix: { kind: 'draft-summary' } });
    setBusy(false);
    setNotice({
      appearance: outcome.applied ? 'success' : 'warning',
      text: outcome.detail,
    });
  };

  if (!result) {
    return (
      <Box padding="space.200">
        <Inline alignBlock="center" space="space.100">
          <Spinner size="medium" />
          <Text>Checking this page against its declared state…</Text>
        </Inline>
      </Box>
    );
  }

  const { page, consistent, verdict, findings, source } = result;

  return (
    <Box padding="space.200">
      <Stack space="space.200">
        <Heading as="h3">RuleBridge</Heading>
        <Text>
          “{page.title}” — declared state: {page.statusSignal || '(none declared)'}
        </Text>
        {source === 'fixture' && (
          <SectionMessage title="Demo data" appearance="information">
            <Text>
              Live read unavailable, so this verdict uses the built-in demo page. Deploy the
              app to a site to check the real page.
            </Text>
          </SectionMessage>
        )}
        {notice && (
          <SectionMessage
            title={notice.appearance === 'success' ? 'Fix applied' : 'Fix not applied'}
            appearance={notice.appearance}
          >
            <Text>{notice.text}</Text>
          </SectionMessage>
        )}
        {consistent ? (
          <SectionMessage title="Consistent" appearance="success">
            <Text>{verdict}</Text>
          </SectionMessage>
        ) : (
          <>
            <SectionMessage title="This page contradicts itself" appearance="warning">
              <Text>{verdict}</Text>
            </SectionMessage>
            {findings.map((finding) => (
              <Stack key={finding.rule} space="space.100">
                <Inline space="space.100" alignBlock="center">
                  <Lozenge appearance="inprogress">{finding.rule}</Lozenge>
                  {finding.claim && <Lozenge appearance="moved">“{finding.claim}”</Lozenge>}
                </Inline>
                <Text>{finding.message}</Text>
                {finding.fix && (
                  <Inline space="space.100">
                    <Button
                      appearance="primary"
                      isDisabled={busy}
                      onClick={() => applyFix(finding.fix)}
                    >
                      {finding.fix.label}
                    </Button>
                  </Inline>
                )}
              </Stack>
            ))}
            <Inline space="space.100">
              <Button isDisabled={busy} onClick={draftSummary}>
                Draft unresolved-items summary at page top
              </Button>
            </Inline>
          </>
        )}
      </Stack>
    </Box>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
