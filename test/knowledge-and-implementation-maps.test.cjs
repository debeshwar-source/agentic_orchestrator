'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { formatCondensedMap, deriveFallbackSummary, MAX_ENTRIES_SHOWN } = loadTs('src/shared/knowledgeMap.ts');
const { formatImplementationSummary, MAX_ENTRIES_SHOWN: MAX_IMPL_SHOWN } = loadTs('src/shared/implementationSummary.ts');

test('an empty knowledge base says so plainly, not an empty list', () => {
  const text = formatCondensedMap([], '/kb/docs');
  assert.match(text, /empty/i);
});

test('the condensed map stays bounded as the corpus grows past the cap', () => {
  const entries = Array.from({ length: MAX_ENTRIES_SHOWN + 25 }, (_, i) => ({ id: `d${i}`, title: `Doc ${i}`, summary: `summary ${i}` }));
  const text = formatCondensedMap(entries, '/kb/docs');
  assert.match(text, /25 more document/);
  // bounded: shouldn't contain every single doc's title literally
  assert.ok(!text.includes('Doc ' + (MAX_ENTRIES_SHOWN + 24)));
});

test('the condensed map names how to fetch the full document, not just the summary', () => {
  const text = formatCondensedMap([{ id: 'abc', title: 'Refund policy', summary: 'How refunds work' }], '/kb/docs');
  assert.match(text, /kg get/);
  assert.match(text, /\/kb\/docs\/<id>\/text\.md/);
});

test('a fallback summary is derived deterministically when no caption was given', () => {
  const text = 'Title Line\n\n\nThis is the first real sentence of the document.\nMore text follows.';
  const s1 = deriveFallbackSummary(text, 'Title Line');
  const s2 = deriveFallbackSummary(text, 'Title Line');
  assert.equal(s1, s2); // deterministic, not a model call
  assert.match(s1, /first real sentence/);
});

test('a fallback summary falls back to the title when the text has nothing usable', () => {
  assert.equal(deriveFallbackSummary('', 'Blank File'), 'Blank File');
});

test('an empty implementation history says so plainly', () => {
  assert.match(formatImplementationSummary([], '/hive/tasks.json'), /nothing completed/i);
});

test('implementation summary stays bounded and points at the full history', () => {
  const entries = Array.from({ length: MAX_IMPL_SHOWN + 10 }, (_, i) => ({ stepId: `s${i}`, stepName: `Step ${i}`, summary: `did ${i}`, approvedAt: 'now' }));
  const text = formatImplementationSummary(entries, '/hive/tasks.json');
  assert.match(text, /10 earlier step/);
  assert.match(text, /tasks\.json/);
});

test('implementation summary names each completed step by name, not just an id', () => {
  const text = formatImplementationSummary([{ stepId: 'draft', stepName: 'Draft', summary: 'Wrote the intro and body.', approvedAt: 'now' }], '/hive/tasks.json');
  assert.match(text, /\*\*Draft\*\*: Wrote the intro and body\./);
});
