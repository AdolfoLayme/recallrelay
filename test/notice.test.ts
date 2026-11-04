import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNotice } from '../src/notice.ts';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { DEMO_NOTICE_DRAFT_DE } from '../src/demo.ts';

const input = { productName: 'Lumen Mini Space Heater', brand: 'Harbor & Pine', identifiers: ['HP-LMH-015'],
  imageReference: 'https://example.test/image.jpg', soldWhere: 'Online', soldWhen: '2026', soldBy: 'Harbor & Pine',
  hazard: 'Fire hazard', remedies: ['Refund', 'Replacement'], contact: 'https://example.test/help' };

test('fake provider produces notices accepted for four languages', async () => {
  const provider = new FakeAiProvider();
  for (const language of ['en', 'fr', 'es', 'de']) {
    const text = await provider.draftNotice(input, language);
    assert.deepEqual(checkNotice(text, { ...input, language, euBuyer: true }), { ok: true, problems: [] });
  }
});

test('notice checker rejects banned minimization and missing product detail', () => {
  const text = awaitableNotice();
  assert.ok(checkNotice(text + '\nThis is voluntary.', { ...input, language: 'en', euBuyer: true }).problems.some(x => x.includes('banned')));
  assert.ok(checkNotice(text.replace('HP-LMH-015', ''), { ...input, language: 'en', euBuyer: true }).problems.some(x => x.includes('identifier')));
});

test('German demo prose keeps every required fact and flags only the softening sentence', async () => {
  const context = { ...input, imageReference: '', contact: 'https://help.harborpine.example',
    productName: 'Harbor & Pine Lumen Mini Space Heater', identifiers: ['HP-LMH-015'],
    hazard: 'The power cord can overheat, posing fire and burn hazards.',
    remedies: ['free refund', 'free replacement'], soldWhere: 'online', soldWhen: undefined, soldBy: undefined };
  const draft = DEMO_NOTICE_DRAFT_DE;
  assert.match(draft, /Lumen Mini Space Heater, Modell HP-LMH-015/);
  assert.match(draft, /Das Netzkabel kann überhitzen/);
  assert.match(draft, /Rückerstattung oder Austausch/);
  assert.deepEqual(checkNotice(draft, { ...context, language: 'de', euBuyer: true }), { ok: true, problems: [] });
  const warned = draft.replace('Verwenden Sie das Gerät', 'Dieser Rückruf erfolgt vorsorglich.\n\nVerwenden Sie das Gerät');
  assert.deepEqual(checkNotice(warned, { ...context, language: 'de', euBuyer: true }),
    { ok: false, problems: ['Contains banned risk-minimizing wording'] });
  assert.ok(checkNotice(draft.replace('Das Netzkabel kann überhitzen.', ''),
    { ...context, language: 'de', euBuyer: true }).problems.includes('Missing hazard'));
  assert.ok(checkNotice(draft.replace('Rückerstattung oder Austausch', 'Rückerstattung'),
    { ...context, language: 'de', euBuyer: true }).problems.includes('Missing remedies'));
});

function awaitableNotice(): string {
  return `Product safety recall\nHarbor & Pine Lumen Mini Space Heater\nHP-LMH-015\nhttps://example.test/image.jpg\nOnline\n2026\nHarbor & Pine\nFire hazard\nStop using this product immediately.\nRefund, Replacement\nhttps://example.test/help`;
}
