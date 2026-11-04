import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCpsc } from '../src/sources/cpsc.ts';
import { parseCanada } from '../src/sources/canada.ts';
import { parseUk } from '../src/sources/uk.ts';
import { parseEu } from '../src/sources/eu.ts';
import { parseOecd } from '../src/sources/oecd.ts';
import { loadSources } from '../src/sources/index.ts';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/sources/${name}.json`, import.meta.url), 'utf8'));

test('CPSC adapter reads real notice text and original URL', () => {
  const notice = parseCpsc(fixture('cpsc'))[0];
  assert.equal(notice.source, 'CPSC');
  assert.ok(notice.rawText.includes(notice.title));
  assert.ok(notice.url.startsWith('https://'));
});

test('Health Canada filters consumer product notices', () => {
  const notice = parseCanada(fixture('canada'))[0];
  assert.equal(notice.source, 'HEALTH_CANADA');
  assert.equal(notice.country, 'CA');
  assert.ok(notice.rawText.length > 50);
});

test('GOV.UK search result maps to a useful recall stub', () => {
  const notice = parseUk(fixture('uk'))[0];
  assert.equal(notice.source, 'GOV_UK');
  assert.ok(notice.url.startsWith('https://www.gov.uk/'));
});

test('EU detail keeps country, sold online and identifier', () => {
  const notice = parseEu(fixture('eu'))[0];
  assert.equal(notice.source, 'EU_SAFETY_GATE');
  assert.equal(notice.soldOnline, true);
  assert.ok(notice.identifiers.length > 0);
});

test('OECD stores only link and essential fields', () => {
  const notice = parseOecd(fixture('oecd'))[0];
  assert.equal(notice.source, 'OECD_GLOBAL_RECALLS');
  assert.equal(notice.country, 'AU');
  assert.ok(notice.url.includes('productsafety.gov.au'));
});

test('one source failure degrades only that source', async () => {
  const result = await loadSources(async (name) => {
    if (name === 'CPSC') throw new Error('offline');
    return fixture({ HEALTH_CANADA: 'canada', GOV_UK: 'uk', EU_SAFETY_GATE: 'eu', OECD_GLOBAL_RECALLS: 'oecd' }[name]!);
  });
  assert.equal(result.status.CPSC.ok, false);
  assert.equal(result.status.GOV_UK.ok, true);
  assert.ok(result.notices.length >= 4);
});
