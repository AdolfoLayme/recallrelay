import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { approvalUrl } from '../scripts/sandbox-smoke.ts';

test('secret scanner rejects a key pattern without printing its value', () => {
  const dir = mkdtempSync('scripts/.scan-test-');
  try {
    const file = `${dir}/input.txt`;
    const fakeKey = 'AKIA' + 'A'.repeat(16);
    writeFileSync(file, `credential=${fakeKey}\n`);
    const hit = spawnSync('bash', ['scripts/check-secrets.sh', file], { encoding: 'utf8' });
    assert.equal(hit.status, 1);
    assert.ok(!`${hit.stdout}${hit.stderr}`.includes(fakeKey));
    writeFileSync(file, 'a harmless local fixture\n');
    const clean = spawnSync('bash', ['scripts/check-secrets.sh', file], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('smoke uses only the approval link returned by PayPal', () => {
  assert.equal(approvalUrl({ links: [{ rel: 'self', href: 'https://api-m.sandbox.paypal.com/self' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=example' }] }), 'https://www.sandbox.paypal.com/checkoutnow?token=example');
  assert.throws(() => approvalUrl({ links: [{ rel: 'self', href: 'https://example.test/' }] }), /approval/i);
  assert.throws(() => approvalUrl({ links: [{ rel: 'approve', href: 'https://www.paypal.com/live' }] }), /sandbox/i);
});
