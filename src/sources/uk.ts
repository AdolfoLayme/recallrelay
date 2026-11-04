import type { RecallNotice } from './types.ts';
import { obj, objects, str } from './types.ts';

export function parseUk(input: unknown): RecallNotice[] {
  return objects(obj(input).results).map(row => {
    const title = str(row.title);
    return {
      id: `uk:${str(row.link)}`, source: 'GOV_UK' as const, country: 'GB', publishedAt: str(row.public_timestamp),
      title, rawText: title, url: new URL(str(row.link), 'https://www.gov.uk').toString(), language: 'en',
      imageUrls: [], identifiers: [],
    };
  }).filter(x => x.title && x.url.startsWith('https://www.gov.uk/'));
}
