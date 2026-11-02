import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qi, ql } from './quote.mjs'

test('quotes identifiers and literals safely', () => {
  assert.equal(qi('todos'), '"todos"')
  assert.equal(qi('a"b'), '"a""b"')
  assert.equal(ql("it's"), "'it''s'")
  assert.equal(ql("'); drop table x; --"), "'''); drop table x; --'")
})
