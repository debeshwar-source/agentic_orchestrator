import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';

/**
 * WORKFLOW — import a workflow definition (a .json file, or a folder holding
 * workflow.json) and review its steps. An import is always stored UNCONFIRMED;
 * only the human "confirm" button here lets it govern a run (the code-enforced
 * gate lives in src/shared/workflowRules.ts).
 */

type WorkflowState = Awaited<ReturnType<typeof window.cth.workflowGet>>;

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};
const muted: React.CSSProperties = { fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: 0 };

export function WorkflowTab() {
  const { t } = useTranslation();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    window.cth.workflowGet().then(setState).catch(() => { /* main not ready */ });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const importWorkflow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.cth.workflowImport();
      if (res.ok) setState({ workflow: res.workflow, problems: res.problems });
      else if (res.error !== 'cancelled') setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const setConfirmed = useCallback(async (confirmed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.cth.workflowConfirm(confirmed);
      if (!res.ok) setError(res.error ?? 'Could not update the workflow.');
      refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const workflow = state?.workflow ?? null;
  const problems = state?.problems ?? [];
  const steps = workflow ? Object.values(workflow.steps) : [];
  const nameOf = (id: string) => workflow?.steps[id]?.name ?? id;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px 16px', overflow: 'auto' }}>
      <div>
        <span style={sectionHead}>{t('workflowTab.title', 'Workflow')}</span>
        <p style={{ ...muted, margin: '2px 0 8px' }}>
          {t('workflowTab.intro', 'Import a workflow as a .json file, or pick a folder that contains workflow.json. Imports start unconfirmed and cannot govern a run until you confirm them.')}
        </p>
        <PixelButton size="sm" onClick={importWorkflow} disabled={busy}>
          {t('workflowTab.import', 'Import file or folder...')}
        </PixelButton>
        {error && (
          <p style={{ ...muted, color: 'var(--cth-red, #b3261e)', marginTop: 8 }}>{error}</p>
        )}
      </div>

      {!workflow ? (
        <div style={{ ...card, ...muted }}>
          {t('workflowTab.none', 'No workflow yet. Import one to get started.')}
          <pre style={{ margin: '6px 0 0', fontFamily: 'var(--cth-font-mono)', fontSize: 10, whiteSpace: 'pre-wrap' }}>{`{
  "name": "Ship a feature",
  "steps": [
    { "id": "plan", "name": "Plan", "is_start": true, "allowed_next": ["build"] },
    { "id": "build", "name": "Build", "allowed_next": ["review"] },
    { "id": "review", "name": "Review", "requires_human_approval": true, "allowed_next": [] }
  ]
}`}</pre>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ ...sectionHead, textTransform: 'none', fontSize: 13 }}>{workflow.name}</span>
            <span style={{
              fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px', textTransform: 'uppercase',
              letterSpacing: 0.5, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              background: workflow.confirmed ? 'var(--cth-green, #2f8f4e)' : 'transparent',
              color: workflow.confirmed ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)'
            }}>
              {workflow.confirmed ? t('workflowTab.confirmed', 'confirmed') : t('workflowTab.draft', 'draft')}
            </span>
          </div>

          {problems.length > 0 && (
            <div style={{ ...card, ...muted, color: 'var(--cth-red, #b3261e)' }}>
              {problems.map((p) => <div key={p}>{p}</div>)}
            </div>
          )}

          {steps.map((s, i) => (
            <div key={s.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' }}>{i + 1}.</span>
                <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>{s.name}</span>
                {s.isStart && <span style={{ ...muted, fontFamily: 'var(--cth-font-mono)' }}>start</span>}
                {s.requiresHumanApproval && <span style={{ ...muted, fontFamily: 'var(--cth-font-mono)' }}>human approval</span>}
              </div>
              {s.description && <p style={muted}>{s.description}</p>}
              <p style={{ ...muted, fontFamily: 'var(--cth-font-mono)' }}>
                {s.allowedNext.length
                  ? `-> ${s.allowedNext.map(nameOf).join(', ')}`
                  : t('workflowTab.terminal', 'final step')}
              </p>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8 }}>
            {workflow.confirmed ? (
              <PixelButton size="sm" variant="secondary" onClick={() => setConfirmed(false)} disabled={busy}>
                {t('workflowTab.unconfirm', 'Revert to draft')}
              </PixelButton>
            ) : (
              <PixelButton size="sm" onClick={() => setConfirmed(true)} disabled={busy || problems.length > 0}>
                {t('workflowTab.confirm', 'Confirm workflow')}
              </PixelButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
