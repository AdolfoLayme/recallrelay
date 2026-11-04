import type { RecallNotice } from './types.ts';
import { objects, obj, str } from './types.ts';

export function parseCpsc(input: unknown): RecallNotice[] {
  return objects(input).map(row => {
    const title = str(row.Title);
    const description = str(row.Description);
    const hazard = objects(row.Hazards).map(x => str(x.Name)).filter(Boolean).join('; ');
    const products = objects(row.Products);
    const identifiers = [
      ...products.map(x => str(x.Model)),
      ...objects(row.ProductUPCs).map(x => str(x.UPC)),
    ].filter(Boolean);
    return {
      id: `cpsc:${String(row.RecallID ?? row.RecallNumber ?? '')}`, source: 'CPSC' as const, country: 'US',
      publishedAt: str(row.RecallDate), title, rawText: [title, description, ...products.map(x => str(x.Name)), hazard].filter(Boolean).join('\n'),
      url: str(row.URL), language: 'en', imageUrls: objects(row.Images).map(x => str(x.URL)).filter(Boolean), hazard, identifiers,
    };
  }).filter(x => x.id !== 'cpsc:' && x.url.startsWith('https://'));
}
