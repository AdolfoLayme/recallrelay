import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.ts';
import { createRemedyToken, verifyRemedyToken, recordBuyerChoice } from '../src/remedy-link.ts';

const secret = 'local-test-signing-secret';
const now = Date.parse('2026-11-03T00:00:00Z');

test('signed remedy token rejects tampering and expiry', () => {
  const token = createRemedyToken({ sessionId: 's', orderId: 'o', recallId: 'r', expiresAt: now + 1000 }, secret);
  assert.equal(verifyRemedyToken(token, secret, now).orderId, 'o');
  assert.throws(() => verifyRemedyToken(token + 'x', secret, now), /token/i);
  assert.throws(() => verifyRemedyToken(token, secret, now + 1001), /expired/i);
});

test('buyer choice is single use, idempotent and session scoped', () => {
  const db = createDatabase(':memory:');
  db.prepare("INSERT INTO sessions(id,expires_at) VALUES('s1',9999999999999),('s2',9999999999999)").run();
  const token = createRemedyToken({ sessionId: 's1', orderId: 'o1', recallId: 'r1', expiresAt: now + 1000 }, secret);
  assert.throws(() => recordBuyerChoice(db, 's2', token, 'refund', secret, now), /session/i);
  assert.equal(recordBuyerChoice(db, 's1', token, 'repair', secret, now).choice, 'repair');
  assert.equal(recordBuyerChoice(db, 's1', token, 'repair', secret, now).choice, 'repair');
  assert.throws(() => recordBuyerChoice(db, 's1', token, 'refund', secret, now), /already/i);
  assert.equal(db.prepare('SELECT count(*) n FROM remedy_choices').get()?.n, 1);
  db.close();
});
