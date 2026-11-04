import type { RecallNotice } from './types.ts';
import { objects, str } from './types.ts';

export function parseCanada(input: unknown): RecallNotice[] {
  return objects(input).filter(row => str(row.Organization) === 'Consumer product safety').map(row => {
    const title = str(row.Title);
    const hazard = str(row.Issue);
    return {
      id: `hc:${str(row.NID)}`, source: 'HEALTH_CANADA' as const, country: 'CA',
      publishedAt: str(row['Last updated']), title,
      rawText: [title, str(row.Product), hazard, str(row['What you should do'])].filter(Boolean).join('\n'),
      url: str(row.URL), language: 'en', imageUrls: [], hazard,
      identifiers: [],
    };
  }).filter(x => x.id !== 'hc:' && x.url.startsWith('https://'));
}
