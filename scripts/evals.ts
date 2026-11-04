import { readFileSync, writeFileSync } from 'node:fs';
import { FakeAiProvider } from '../src/ai/fake.ts';
import { parseCpsc } from '../src/sources/cpsc.ts';
import { parseCanada } from '../src/sources/canada.ts';
import { parseUk } from '../src/sources/uk.ts';
import { parseEu } from '../src/sources/eu.ts';
import { parseOecd } from '../src/sources/oecd.ts';
import type { RecallNotice } from '../src/sources/types.ts';

type EvalCase = { id: string; fixture: string; appendText: string; expectedIdentifiers: string[] };
const cases = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as EvalCase[];
const parsers: Record<string, (raw: unknown) => RecallNotice[]> = {
  cpsc: parseCpsc, canada: parseCanada, uk: parseUk, eu: parseEu, oecd: parseOecd,
};
const provider = new FakeAiProvider();
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
for (const entry of cases) {
  const parser = parsers[entry.fixture];
  if (!parser) throw new Error(`Unknown fixture ${entry.fixture}`);
  const raw = JSON.parse(readFileSync(`fixtures/sources/${entry.fixture}.json`, 'utf8')) as unknown;
  const source = parser(raw)[0];
  if (!source) throw new Error(`Empty fixture ${entry.fixture}`);
  const extraction = await provider.extractRecall({ ...source, rawText: source.rawText + entry.appendText });
  const predicted = new Set(extraction.products.flatMap(product => [product.sku, product.gtin].filter(Boolean)));
  const expected = new Set(entry.expectedIdentifiers);
  for (const value of predicted) expected.has(value) ? truePositive++ : falsePositive++;
  for (const value of expected) if (!predicted.has(value)) falseNegative++;
}
const result = {
  cases: cases.length, truePositive, falsePositive, falseNegative,
  precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 1,
  recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 1,
};
writeFileSync('evals/results.json', JSON.stringify(result, null, 2) + '\n');
console.log(`Cases: ${result.cases}; identifier precision: ${result.precision.toFixed(3)}; recall: ${result.recall.toFixed(3)}`);
