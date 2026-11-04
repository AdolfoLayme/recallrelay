import type { RecallNotice } from './types.ts';
import { obj, objects, str } from './types.ts';

export function parseEu(input: unknown): RecallNotice[] {
  const data = obj(input);
  const detail = obj(data.detail);
  return objects(data.content).map(row => {
    const current = String(detail.id) === String(row.id) ? detail : row;
    const product = obj(current.product);
    const risk = obj(current.risk);
    const traceability = obj(current.traceability);
    const hazard = objects(risk.versions).map(x => str(x.riskDescription)).find(Boolean) ?? objects(risk.riskType).map(x => str(x.name)).join(', ');
    const title = str(product.nameSpecific) || str(product.name);
    const identifiers = [
      ...objects(product.modelTypes).map(x => str(x.name || x.value)),
      ...objects(product.barcodes).map(x => str(x.name || x.value)),
      ...objects(current.onlineTraderProductIdentifierReference).map(x => str(x.uniqueProductIdentifier)),
    ].filter(Boolean);
    return {
      id: `eu:${String(row.id)}`, source: 'EU_SAFETY_GATE' as const, country: str(obj(current.country).key) || 'EU',
      publishedAt: str(current.publicationDate), title,
      rawText: [title, ...objects(product.versions).map(x => str(x.description)), hazard, ...identifiers].filter(Boolean).join('\n'),
      url: `https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/${encodeURIComponent(String(row.id))}`,
      language: 'en', imageUrls: [], hazard, identifiers,
      soldOnline: str(obj(traceability.isSoldOnline).name).toUpperCase() === 'YES',
    };
  }).filter(x => x.title);
}
