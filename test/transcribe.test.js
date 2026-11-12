import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseModelJson, buildPrompt } from '../server/transcribe.js'

test('parses plain JSON', () => {
  const r = parseModelJson('{"original":"कैसे हो bro","english":"How are you bro","language":"mixed"}')
  assert.deepEqual(r, { original: 'कैसे हो bro', english: 'How are you bro', language: 'mixed' })
})

test('parses JSON wrapped in code fences and prose', () => {
  assert.equal(parseModelJson('```json\n{"original":"hi","english":"hi","language":"en"}\n```').english, 'hi')
  assert.equal(parseModelJson('Sure! {"original":"haan","english":"yes","language":"hi"} done').english, 'yes')
})

test('accepts content arrays and alternate keys', () => {
  const r = parseModelJson([{ type: 'text', text: '{"transcript":"accha","translation":"okay"}' }])
  assert.deepEqual(r, { original: 'accha', english: 'okay', language: 'mixed' })
})

test('english-only speech copies original when english missing', () => {
  assert.equal(parseModelJson('{"original":"see you","language":"en"}').english, 'see you')
})

test('silence', () => {
  assert.deepEqual(parseModelJson('{"original":"","english":"","language":"none"}'), { original: '', english: '', language: 'none' })
})

test('rejects non-JSON', () => {
  assert.throws(() => parseModelJson('I cannot hear anything'))
  assert.throws(() => parseModelJson(''))
})

test('prompt includes context only when given', () => {
  assert.ok(!buildPrompt('').includes('previous line'))
  assert.ok(buildPrompt('Asha: hello').includes('Asha: hello'))
})
