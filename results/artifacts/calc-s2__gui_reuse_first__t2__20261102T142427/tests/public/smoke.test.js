import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculator, CalcError } from '../../src/calc.js';
test('basic', () => { const c = createCalculator(); assert.equal(c.evaluate('2^3^2'), 512); });
test('variables and ans', () => { const c = createCalculator(); c.evaluate('x = 4'); assert.equal(c.evaluate('ans * x'), 16); });
test('syntax error position', () => { const c = createCalculator(); try { c.evaluate('2 + * 3'); assert.fail(); } catch (e) { assert.ok(e instanceof CalcError); assert.equal(e.position, 4); } });
