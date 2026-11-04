import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FakeAiProvider } from '../src/ai/fake.ts';

test('offline evals run at least forty labelled cases and write metrics', () => {
  const run = spawnSync(process.execPath, ['scripts/evals.ts'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(readFileSync('evals/results.json', 'utf8')) as { cases: number; precision: number; recall: number; falsePositive: number; falseNegative: number };
  assert.ok(result.cases >= 40);
  assert.ok(result.precision >= 0 && result.precision <= 1);
  assert.ok(result.recall >= 0 && result.recall <= 1);
  assert.equal(result.falsePositive, 0, 'the labelled eval set must contain no injected identifier false positives');
  assert.ok(result.falseNegative > 0, 'unparsed real identifiers must expose a false negative');
});

test('eval adversarial cases never extract injected SKU or GTIN values', async () => {
  const entries = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as { appendText: string }[];
  const provider = new FakeAiProvider();
  for (const entry of entries.filter(x => /instruction/i.test(x.appendText))) {
    const extraction = await provider.extractRecall({ id: 'probe', source: 'CPSC', country: 'US', publishedAt: '2026-01-01',
      title: 'Fictional heater', rawText: `Harbor heater has a fire hazard.${entry.appendText}`,
      url: 'https://example.test', language: 'en', imageUrls: [], identifiers: [] });
    assert.ok(!JSON.stringify(extraction.products).includes('ATTACK-001'));
    assert.ok(!JSON.stringify(extraction.products).includes('12345678'));
  }
});
