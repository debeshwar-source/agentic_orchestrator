/**
 * The workflow engine's pure rules (Lane: harness enforcement, owner's
 * explicit build request 2026-10-08): a user-authored workflow becomes
 * code-checked, not advisory, the same way src/shared/handoffRule.ts
 * already enforces "only Michael assigns" for the fork this originally
 * shipped without. Mirrors that file's own discipline exactly: no
 * electron or node imports, hive.ts calls it, tests load it directly.
 *
 * Three things live here, because they're the three places a
 * coordination decision was previously left entirely to an agent's own
 * judgment and proved unreliable under direct testing earlier today:
 *
 *   validateTransition / validateAssignment   a proposed step is
 *     checked against the DEFINED workflow before it is ever
 *     delivered -- the orchestrator proposes, this disposes.
 *   applySignoffGate                           a task can only be
 *     marked done with a non-empty, criterion-by-criterion verdict
 *     where every criterion is met -- never a bare "looks fine".
 *   evaluateRejectLoop                         a task rejected for the
 *     same reason, repeatedly, escalates instead of looping forever.
 */

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  /** Fixed by the workflow author when known; undefined = any active
   *  hired agent is eligible (checked by validateAssignment, never
   *  taken on faith). */
  assignedAgentId?: string;
  requiresHumanApproval?: boolean;
  /** Step ids reachable from here once this step is signed off. Empty
   *  = a terminal step. */
  allowedNext: string[];
  isStart?: boolean;
}

export interface Workflow {
  name: string;
  steps: Record<string, WorkflowStep>;
  /** The mandatory gate: a workflow drafted from text (or hand-edited)
   *  never governs a real run until a human has looked at it and set
   *  this true. Nothing in this module, and nothing calling it, may
   *  flip this on its own. */
  confirmed: boolean;
  sourceText?: string;
}

export interface ValidationResult {
  ok: boolean;
  reason: string;
}

const ok = (): ValidationResult => ({ ok: true, reason: '' });
const fail = (reason: string): ValidationResult => ({ ok: false, reason });

export function startStep(workflow: Workflow): WorkflowStep | undefined {
  return Object.values(workflow.steps).find((s) => s.isStart);
}

/** The one check every proposed next-step has to pass. `fromStepId` is
 *  undefined only at the very start of a run. Never throws -- a bad
 *  proposal is rejected and the caller decides what to do (redirect,
 *  bounce to the orchestrator), never a crash. */
export function validateTransition(workflow: Workflow, fromStepId: string | undefined, toStepId: string): ValidationResult {
  if (!workflow.confirmed) return fail('This workflow has not been confirmed by a human yet — it cannot govern a real run.');
  const target = workflow.steps[toStepId];
  if (!target) return fail(`'${toStepId}' is not a step in this workflow.`);
  if (fromStepId === undefined) {
    const start = startStep(workflow);
    if (!start) return fail('This workflow has no start step.');
    if (toStepId !== start.id) return fail(`A run must begin at the defined start step ('${start.id}'), not '${toStepId}'.`);
    return ok();
  }
  const source = workflow.steps[fromStepId];
  if (!source) return fail(`'${fromStepId}' is not a step in this workflow.`);
  if (!source.allowedNext.includes(toStepId)) {
    const allowed = source.allowedNext.join(', ') || '(nothing — this is a terminal step)';
    return fail(`'${toStepId}' does not follow '${fromStepId}' in the defined workflow. Allowed next: ${allowed}.`);
  }
  return ok();
}

/** Checked separately from the transition: even a step the workflow
 *  allows next can still be proposed to the wrong agent. `isActiveAgent`
 *  is injected so this stays a pure function over plain data — hive.ts
 *  passes `(id) => !!reg.agents[id] && !reg.agents[id].archived`. */
export function validateAssignment(workflow: Workflow, stepId: string, agentId: string, isActiveAgent: (id: string) => boolean): ValidationResult {
  const step = workflow.steps[stepId];
  if (!step) return fail(`'${stepId}' is not a step in this workflow.`);
  if (step.assignedAgentId && agentId !== step.assignedAgentId) {
    return fail(`Step '${step.name}' is fixed to a specific agent in the defined workflow.`);
  }
  if (!isActiveAgent(agentId)) return fail(`'${agentId}' is not an active hired agent.`);
  return ok();
}

export interface SignoffCriterion {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface SignoffVerdict {
  criteria: SignoffCriterion[];
  rejectionReason: string;
}

export interface GatedSignoff extends SignoffVerdict {
  approved: boolean;
}

/** The deterministic override: an empty criteria list, or any
 *  criterion marked unmet, forces rejection regardless of anything
 *  else the orchestrator said — its sign-off is never taken on faith
 *  just because it used the word "approved" somewhere. */
export function applySignoffGate(verdict: SignoffVerdict): GatedSignoff {
  if (!Array.isArray(verdict.criteria) || verdict.criteria.length === 0) {
    return {
      criteria: [],
      approved: false,
      rejectionReason: verdict.rejectionReason?.trim() || 'No criteria were checked — a sign-off must assess specific criteria, not give a blanket opinion.',
    };
  }
  const unmet = verdict.criteria.filter((c) => !c.met);
  const approved = unmet.length === 0;
  const rejectionReason = !approved && !verdict.rejectionReason?.trim()
    ? unmet.map((c) => `${c.criterion}: ${c.evidence || 'not met'}`).join('; ').slice(0, 500)
    : verdict.rejectionReason ?? '';
  return { criteria: verdict.criteria, approved, rejectionReason };
}

export interface RejectLoopState {
  level: 'ok' | 'steer' | 'stop';
  reason: string;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'not', 'are', 'was', 'has', 'have', 'from']);

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

function similar(a: string, b: string, threshold = 0.5): boolean {
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union >= threshold;
}

/** `history` = rejection reasons for this task, oldest first (the new
 *  one already appended). STEER = recurring, not yet at the cap: the
 *  next dispatch should carry a note that this already came up. STOP =
 *  at or past the cap — the caller must escalate to a human, not
 *  dispatch again. */
export function evaluateRejectLoop(history: string[], rejectCap = 3): RejectLoopState {
  if (history.length < 2) return { level: 'ok', reason: '' };
  let recurring = 0;
  for (let i = 1; i < history.length; i++) if (similar(history[i], history[i - 1])) recurring++;
  if (recurring === 0) return { level: 'ok', reason: '' };
  if (history.length - 1 >= rejectCap) {
    return { level: 'stop', reason: `Rejected ${history.length} times with a recurring reason — needs a human, not another attempt.` };
  }
  return { level: 'steer', reason: `This reason recurred from the previous rejection (${recurring}x so far).` };
}

/** Repairs referential integrity in a model-drafted workflow rather
 *  than trusting it: an allowedNext pointing at a step id that was
 *  never defined is dropped here, never passed through to become a
 *  silent runtime dead end. */
export function cleanDraftedSteps(raw: Array<Record<string, unknown>>): Record<string, WorkflowStep> {
  const steps: Record<string, WorkflowStep> = {};
  let seenStart = false;
  raw.forEach((r, i) => {
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) return;
    let id = String(r.id ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `step-${i}`;
    let n = 2;
    const base = id;
    while (steps[id]) { id = `${base}-${n}`; n++; }
    const isStart = !!r.is_start && !seenStart;
    seenStart = seenStart || isStart;
    steps[id] = {
      id,
      name: name.slice(0, 80),
      description: typeof r.description === 'string' ? r.description.slice(0, 400) : '',
      requiresHumanApproval: !!r.requires_human_approval,
      allowedNext: Array.isArray(r.allowed_next) ? (r.allowed_next as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      isStart,
    };
  });
  if (Object.keys(steps).length && !Object.values(steps).some((s) => s.isStart)) {
    Object.values(steps)[0].isStart = true;
  }
  const validIds = new Set(Object.keys(steps));
  Object.values(steps).forEach((s) => {
    s.allowedNext = s.allowedNext.filter((n) => validIds.has(n) && n !== s.id);
  });
  return steps;
}

/** The convention a dispatch message uses to say which workflow step
 *  it's assigning — a subject-prefix tag, the same idiom this
 *  codebase's own router already uses for `[bounced — …]` /
 *  `[undeliverable — …]` markers, so a human reading the mailbox sees
 *  something consistent with everything else in it. */
const STEP_TAG = /^\[step:([a-z0-9-]+)\]\s*/i;

export function parseStepTag(subject: string): { stepId: string | null; subject: string } {
  const m = subject.match(STEP_TAG);
  return m ? { stepId: m[1].toLowerCase(), subject: subject.slice(m[0].length) } : { stepId: null, subject };
}

export function withStepTag(stepId: string, subject: string): string {
  return `[step:${stepId}] ${subject}`;
}

export type ParseWorkflowResult = { ok: true; workflow: Workflow } | { ok: false; error: string };

const pick = (r: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
};

/** Turns an uploaded workflow file's JSON into a Workflow. Accepts `steps` as an
 *  array or an id-keyed object, and camelCase or snake_case field names. Always
 *  returns `confirmed: false` -- whatever the file claims, only a human clicking
 *  confirm may flip it. */
export function parseImportedWorkflow(raw: unknown, fallbackName = 'Imported workflow'): ParseWorkflowResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Workflow file must be a JSON object.' };
  const obj = raw as Record<string, unknown>;
  const rawSteps = obj.steps;
  let list: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawSteps)) {
    list = rawSteps.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object');
  } else if (rawSteps && typeof rawSteps === 'object') {
    list = Object.entries(rawSteps as Record<string, unknown>)
      .filter(([, s]) => !!s && typeof s === 'object')
      .map(([id, s]) => ({ id, ...(s as Record<string, unknown>) }));
  }
  if (list.length === 0) return { ok: false, error: 'Workflow has no steps. Expected a "steps" array or object.' };

  const slug = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const normalised = list.map((s) => {
    const next = pick(s, 'allowed_next', 'allowedNext');
    return {
    id: s.id,
    name: s.name ?? s.id,
    description: s.description,
    is_start: pick(s, 'is_start', 'isStart'),
    allowed_next: Array.isArray(next) ? next.map((n) => (typeof n === 'string' ? slug(n) : n)) : next,
    requires_human_approval: pick(s, 'requires_human_approval', 'requiresHumanApproval'),
    assigned_agent_id: pick(s, 'assigned_agent_id', 'assignedAgentId'),
    };
  });
  const steps = cleanDraftedSteps(normalised);
  if (Object.keys(steps).length === 0) return { ok: false, error: 'No valid steps found (each step needs a name).' };
  normalised.forEach((n) => {
    const id = slug(n.id ?? n.name);
    if (typeof n.assigned_agent_id === 'string' && n.assigned_agent_id && steps[id]) steps[id].assignedAgentId = n.assigned_agent_id;
  });
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : fallbackName;
  return { ok: true, workflow: { name, steps, confirmed: false, sourceText: typeof obj.sourceText === 'string' ? obj.sourceText : undefined } };
}

/** Checks a workflow is runnable before a human may confirm it. Returns problems; empty = fine. */
export function workflowProblems(workflow: Workflow): string[] {
  const problems: string[] = [];
  const steps = Object.values(workflow.steps);
  if (steps.length === 0) problems.push('No steps defined.');
  if (steps.filter((s) => s.isStart).length !== 1) problems.push('Exactly one step must be the start step.');
  const start = startStep(workflow);
  if (start) {
    const seen = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      for (const n of workflow.steps[queue.pop() as string]?.allowedNext ?? []) {
        if (!seen.has(n) && workflow.steps[n]) { seen.add(n); queue.push(n); }
      }
    }
    const unreachable = steps.filter((s) => !seen.has(s.id)).map((s) => s.name);
    if (unreachable.length) problems.push(`Unreachable from the start step: ${unreachable.join(', ')}.`);
  }
  if (steps.length > 0 && !steps.some((s) => s.allowedNext.length === 0)) problems.push('No terminal step (a step with nothing after it), so a run could never finish.');
  return problems;
}
