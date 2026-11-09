import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  DynamicTable,
  EmptyState,
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
// RuleBridge — Confluence space page (space-level scan)
//
// One row per page in the space whose body contradicts the state the
// page declares, plus a second table for linked decision pages that
// contradict EACH OTHER (Rule 6). The `scanSpace` resolver fetches
// the space's pages (bounded) and runs the same rules engine the
// byline item and the Rovo actions use; this page only renders the
// result. This is the pre-meeting truth check a team lead runs on a
// whole decision space in ten seconds.
// ---------------------------------------------------------------------------

const pageHead = {
  cells: [
    { key: 'page', content: 'Page' },
    { key: 'declared', content: 'Declared state' },
    { key: 'contradiction', content: 'Contradiction' },
    { key: 'fix', content: 'Suggested fix' },
  ],
};

const pairHead = {
  cells: [
    { key: 'topic', content: 'Topic' },
    { key: 'pages', content: 'Pages in conflict' },
    { key: 'detail', content: 'Contradiction' },
  ],
};

const App = () => {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    view
      .getContext()
      .then((ctx) => {
        const spaceKey =
          ctx && ctx.extension && ctx.extension.space ? ctx.extension.space.key : null;
        return invoke('scanSpace', spaceKey ? { spaceKey } : {});
      })
      .then(setResult)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <Box padding="space.200">
        <SectionMessage title="Scan failed" appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      </Box>
    );
  }

  if (!result) {
    return (
      <Box padding="space.200">
        <Inline alignBlock="center" space="space.100">
          <Spinner size="medium" />
          <Text>Scanning the space for self-contradicting pages…</Text>
        </Inline>
      </Box>
    );
  }

  const rows = (result.flagged || []).map((entry) => ({
    key: entry.page.id,
    cells: [
      { key: 'page', content: <Text>{entry.page.title}</Text> },
      {
        key: 'declared',
        content: (
          <Lozenge appearance="inprogress">{entry.page.statusSignal || '(none)'}</Lozenge>
        ),
      },
      {
        key: 'contradiction',
        content: (
          <Stack space="space.050">
            {entry.findings.map((f) => (
              <Text key={f.rule}>{f.message}</Text>
            ))}
          </Stack>
        ),
      },
      {
        key: 'fix',
        content: (
          <Text>
            {entry.findings
              .map((f) => (f.fix ? f.fix.label : ''))
              .filter(Boolean)
              .join('; ') || '—'}
          </Text>
        ),
      },
    ],
  }));

  const pairRows = (result.pairs || []).map((pair) => ({
    key: `${pair.aId}-${pair.bId}-${pair.topic}`,
    cells: [
      { key: 'topic', content: <Text>{pair.topic}</Text> },
      {
        key: 'pages',
        content: <Text>{pair.findings[0] ? pair.findings[0].evidence.a.title : ''} vs {pair.findings[0] ? pair.findings[0].evidence.b.title : ''}</Text>,
      },
      {
        key: 'detail',
        content: <Text>{pair.verdict}</Text>,
      },
    ],
  }));

  return (
    <Box padding="space.200">
      <Stack space="space.200">
        <Heading as="h2">RuleBridge — space contradiction scan</Heading>
        <Text>
          Scanned {result.scanned} pages in {result.spaceKey || 'this space'};{' '}
          {(result.flagged || []).length} contradict the state they declare and{' '}
          {(result.pairs || []).length} linked pair(s) contradict each other.
        </Text>
        {rows.length === 0 ? (
          <EmptyState
            header="No self-contradictions found"
            description="Every scanned page's body agrees with the state it declares. The record is telling the truth."
          />
        ) : (
          <DynamicTable head={pageHead} rows={rows} />
        )}
        {pairRows.length > 0 && (
          <>
            <Heading as="h3">Linked decisions in conflict</Heading>
            <DynamicTable head={pairHead} rows={pairRows} />
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
