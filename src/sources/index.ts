import type { RecallNotice } from './types.ts';
import { parseCpsc } from './cpsc.ts';
import { parseCanada } from './canada.ts';
import { parseUk } from './uk.ts';
import { parseEu } from './eu.ts';
import { parseOecd } from './oecd.ts';

export type SourceName = Exclude<RecallNotice['source'], 'DEMO'>;
export const sourceNames: SourceName[] = ['CPSC', 'HEALTH_CANADA', 'GOV_UK', 'EU_SAFETY_GATE', 'OECD_GLOBAL_RECALLS'];
const parsers = { CPSC: parseCpsc, HEALTH_CANADA: parseCanada, GOV_UK: parseUk, EU_SAFETY_GATE: parseEu, OECD_GLOBAL_RECALLS: parseOecd };

export async function fetchSource(name: SourceName): Promise<unknown> {
  const headers = { 'User-Agent': 'RecallRelay/0.1 (product recall research)', Accept: 'application/json' };
  const urls: Record<SourceName, string> = {
    CPSC: `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10)}`,
    HEALTH_CANADA: 'https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json',
    GOV_UK: 'https://www.gov.uk/api/search.json?filter_format=product_safety_alert_report_recall&count=50&order=-public_timestamp&fields=title,link,public_timestamp',
    EU_SAFETY_GATE: 'https://ec.europa.eu/safety-gate-alerts/public/api/notification/carousel/?',
    OECD_GLOBAL_RECALLS: 'https://globalrecalls.oecd.org/ws/search.xqy?end=20&lang=en&order=desc&q=&sort=date&start=0&uiLang=en',
  };
  const response = await fetch(urls[name], name === 'EU_SAFETY_GATE'
    ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en', page: 0 }), signal: AbortSignal.timeout(30_000) }
    : { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${name} unavailable`);
  const data = await response.json();
  if (name !== 'EU_SAFETY_GATE') return data;
  const first = (data as { content?: { id?: number }[] }).content?.[0];
  if (!first?.id) return data;
  const detailResponse = await fetch(`https://ec.europa.eu/safety-gate-alerts/public/api/notification/${first.id}?language=en`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!detailResponse.ok) return data;
  return { ...(data as object), detail: await detailResponse.json() };
}

export async function loadSources(loader: (name: SourceName) => Promise<unknown> = fetchSource): Promise<{
  notices: RecallNotice[];
  status: Record<SourceName, { ok: boolean; count: number; error?: string }>;
}> {
  const results = await Promise.all(sourceNames.map(async name => {
    try {
      const notices = parsers[name](await loader(name));
      return { name, notices, status: { ok: true, count: notices.length } };
    } catch {
      return { name, notices: [] as RecallNotice[], status: { ok: false, count: 0, error: 'Source unavailable' } };
    }
  }));
  return {
    notices: results.flatMap(x => x.notices),
    status: Object.fromEntries(results.map(x => [x.name, x.status])) as Record<SourceName, { ok: boolean; count: number; error?: string }>,
  };
}
