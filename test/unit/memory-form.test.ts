import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeMemoryForm } from '../../web/src/memoryForm.ts';
import { parseGoalContent, parseLessonContent, parseNoteContent } from '../../src/core/memory/records.ts';

test('workbench forms: optional blanks omitted so problem/research notes and lessons can submit', () => {
  const problem = serializeMemoryForm({ type: 'problem', body: '  exact\n正文🙂  ', rootCause: 'cause', conclusion: '' });
  assert.equal(parseNoteContent(problem)?.body, '  exact\n正文🙂  ');
  assert.equal(Object.hasOwn(JSON.parse(problem), 'conclusion'), false);
  assert.equal(parseNoteContent(serializeMemoryForm({ type: 'research', body: 'body', rootCause: '', conclusion: 'result' }))?.conclusion, 'result');
  assert.doesNotThrow(() => parseLessonContent(serializeMemoryForm({ type: 'lesson', category: '假设错', body: 'body', fix: 'fix', rootCause: 'cause', source: '', symptom: '', scope: '' })));
  assert.doesNotThrow(() => parseLessonContent(serializeMemoryForm({ type: 'experience', category: '机制', body: 'body', fix: 'fix', source: 'source.ts:1', rootCause: '', symptom: '', scope: '' })));
  assert.doesNotThrow(() => parseGoalContent(serializeMemoryForm({ parentId: null, state: 'root', keyResults: [], lessons: [], body: '' })));
});
test('workbench forms: omitted required blank fields still fail domain validation', () => {
  assert.throws(() => parseNoteContent(serializeMemoryForm({ type: 'problem', body: 'body', rootCause: '' })), /根因/);
  assert.throws(() => parseNoteContent(serializeMemoryForm({ type: 'research', body: 'body', conclusion: '' })), /结论/);
  assert.throws(() => parseLessonContent(serializeMemoryForm({ type: 'experience', category: '机制', body: 'body', fix: 'fix', source: '' })), /出处/);
});
