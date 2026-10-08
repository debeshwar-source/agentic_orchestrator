'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  validateTransition,
  validateAssignment,
  applySignoffGate,
  evaluateRejectLoop,
  cleanDraftedSteps,
  parseStepTag,
  withStepTag,
  parseImportedWorkflow,
  workflowProblems
} = loadTs('src/shared/workflowRules.ts');

function simpleWorkflow(confirmed = true) {
  return {
    name: 'Draft and review',
    confirmed,
    steps: {
      draft: { id: 'draft', name: 'Draft', description: 'Write a first draft.', isStart: true, allowedNext: ['review'] },
      review: { id: 'review', name: 'Review', description: 'Check it covers the brief.', allowedNext: [] }
    }
  };
}

test('a step outside the defined workflow is rejected, not silently run', () => {
  const r = validateTransition(simpleWorkflow(), 'draft', 'release');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a step/);
});

test('a step within the defined workflow is allowed', () => {
  assert.equal(validateTransition(simpleWorkflow(), 'draft', 'review').ok, true);
});

test('an unconfirmed workflow governs nothing', () => {
  const r = validateTransition(simpleWorkflow(false), undefined, 'draft');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not been confirmed/);
});

test('a run must begin at the defined start step', () => {
  const r = validateTransition(simpleWorkflow(), undefined, 'review');
  assert.equal(r.ok, false);
});

test('assignment is rejected for an archived or unknown agent', () => {
  const wf = simpleWorkflow();
  const r = validateAssignment(wf, 'draft', 'scribe', () => false);
  assert.equal(r.ok, false);
});

test('assignment to a step fixed to a different agent is rejected even if the proposed agent is active', () => {
  const wf = simpleWorkflow();
  wf.steps.draft.assignedAgentId = 'scribe';
  const r = validateAssignment(wf, 'draft', 'someone-else', () => true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /fixed to a specific agent/);
});

test('empty criteria forces rejection — no blanket approval', () => {
  const r = applySignoffGate({ criteria: [], rejectionReason: '' });
  assert.equal(r.approved, false);
  assert.match(r.rejectionReason, /No criteria/);
});

test('one unmet criterion forces rejection even if others pass', () => {
  const r = applySignoffGate({
    criteria: [
      { criterion: 'A', met: true, evidence: 'ok' },
      { criterion: 'B', met: false, evidence: 'missing' }
    ],
    rejectionReason: ''
  });
  assert.equal(r.approved, false);
});

test('all criteria met approves', () => {
  const r = applySignoffGate({ criteria: [{ criterion: 'A', met: true, evidence: 'ok' }], rejectionReason: '' });
  assert.equal(r.approved, true);
});

test('a single rejection is not stagnation', () => {
  assert.equal(evaluateRejectLoop(['missing the intro section']).level, 'ok');
});

test('a recurring rejection reason steers then stops', () => {
  const reason = 'missing the intro section entirely';
  const history = [reason];
  const levels = [];
  for (let i = 0; i < 4; i++) { history.push(reason); levels.push(evaluateRejectLoop(history, 3).level); }
  assert.equal(levels[0], 'steer');
  assert.ok(levels.includes('stop'));
});

test('different rejection reasons never trip stagnation', () => {
  const history = ['wrong tone', 'missing a citation', 'too long', 'off topic'];
  assert.equal(evaluateRejectLoop(history).level, 'ok');
});

test('a drafted workflow with a dangling edge has it repaired, not passed through', () => {
  const steps = cleanDraftedSteps([
    { id: 'a', name: 'A', is_start: true, allowed_next: ['b', 'nonexistent'] },
    { id: 'b', name: 'B', allowed_next: [] }
  ]);
  assert.deepEqual(steps.a.allowedNext, ['b']);
});

test('step tags round-trip through a subject line', () => {
  const tagged = withStepTag('draft', 'Please write the intro');
  const parsed = parseStepTag(tagged);
  assert.equal(parsed.stepId, 'draft');
  assert.equal(parsed.subject, 'Please write the intro');
});

test('a subject with no step tag parses as untagged', () => {
  const parsed = parseStepTag('just a normal message');
  assert.equal(parsed.stepId, null);
});

test('an imported workflow is always unconfirmed, whatever the file claims', () => {
  const r = parseImportedWorkflow({
    name: 'X', confirmed: true,
    steps: [
      { id: 'a', name: 'A', isStart: true, allowedNext: ['b', 'ghost'] },
      { id: 'b', name: 'B', allowed_next: [], assigned_agent_id: 'agent-1' }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.workflow.confirmed, false);
  assert.deepEqual(r.workflow.steps.a.allowedNext, ['b']);
  assert.equal(r.workflow.steps.b.assignedAgentId, 'agent-1');
  assert.deepEqual(workflowProblems(r.workflow), []);
});

test('import accepts an id-keyed steps object and rejects empty or non-object input', () => {
  const ok = parseImportedWorkflow({ steps: { one: { name: 'One', is_start: true } } }, 'fallback');
  assert.equal(ok.ok, true);
  assert.equal(ok.workflow.name, 'fallback');
  assert.equal(parseImportedWorkflow([]).ok, false);
  assert.equal(parseImportedWorkflow({ steps: [] }).ok, false);
});

test('workflowProblems flags an unreachable step', () => {
  const wf = parseImportedWorkflow({ steps: [
    { id: 'a', name: 'A', is_start: true, allowed_next: ['b'] },
    { id: 'b', name: 'B', allowed_next: [] },
    { id: 'c', name: 'C', allowed_next: ['b'] }
  ] }).workflow;
  assert.match(workflowProblems(wf).join(' '), /Unreachable from the start step: C/);
});

test('workflowProblems flags a workflow with no terminal step', () => {
  const wf = parseImportedWorkflow({ steps: [
    { id: 'a', name: 'A', is_start: true, allowed_next: ['b'] },
    { id: 'b', name: 'B', allowed_next: ['a'] }
  ] }).workflow;
  assert.match(workflowProblems(wf).join(' '), /No terminal step/);
});

test('import normalises ids and the references to them the same way', () => {
  const r = parseImportedWorkflow({ steps: [
    { id: 'failure_analysis', name: 'Failure Analysis', is_start: true, allowed_next: ['Final_Step'] },
    { id: 'Final_Step', name: 'Final', allowed_next: [] }
  ] });
  assert.deepEqual(r.workflow.steps['failure-analysis'].allowedNext, ['final-step']);
  assert.deepEqual(workflowProblems(r.workflow), []);
});
