import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactLog } from '../src/config.ts';

test('fake mode needs no keys and sandbox refuses missing credentials', () => {
  assert.equal(loadConfig({}).paypalMode, 'fake');
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'sandbox' }), /PAYPAL_CLIENT_ID/);
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PAYPAL_WEBHOOK_ID: 'c' }), /LINK_SIGNING_SECRET/);
});

test('redaction removes credentials, bearer tokens and email addresses', () => {
  const text = redactLog({ Authorization: 'Bearer top-secret', client_secret: 'secret', access_token: 'token', email: 'buyer@example.test' });
  assert.deepEqual(JSON.parse(text), { Authorization: '[REDACTED]', client_secret: '[REDACTED]', access_token: '[REDACTED]', email: '[REDACTED]' });
  for (const value of ['top-secret', 'buyer@example.test']) assert.ok(!text.includes(value));
});
