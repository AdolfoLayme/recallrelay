import type { RecallNotice } from './types.ts';
import { obj, objects, str } from './types.ts';

export function parseOecd(input: unknown): RecallNotice[] {
  return objects(obj(input).results).map(row => {
    const title = str(row['product.name']);
    return {
      id: `oecd:${str(row.id)}`, source: 'OECD_GLOBAL_RECALLS' as const, country: str(row.countryId),
      publishedAt: str(row.date), title, rawText: title, url: str(row.extUrl),
      language: 'en', imageUrls: str(row.imageUri) ? [str(row.imageUri)] : [], identifiers: [],
    };
  }).filter(x => x.id !== 'oecd:' && /^https?:\/\//.test(x.url));
}
