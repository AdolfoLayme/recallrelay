import type { RecallNotice } from '../sources/types.ts';
import { factualNoticeText, validateExtraction } from './provider.ts';
import type { AiProvider, Extraction, NoticeDraftInput } from './provider.ts';

export class FakeAiProvider implements AiProvider {
  async extractRecall(notice: RecallNotice): Promise<Extraction> {
    const text = factualNoticeText(notice.rawText);
    const brand = /\b([A-Z][a-z]+)\s+(?:heater|lamp|pillow|coffee maker)/i.exec(text)?.[1] ?? '';
    const model = /\bmodel\s+([A-Za-z0-9-]+)/i.exec(text)?.[1] ?? '';
    const sku = /\bSKU\s+([A-Za-z0-9-]+)/i.exec(text)?.[1] ?? notice.identifiers.find(x => text.includes(x)) ?? '';
    const gtin = /\bGTIN\s+(\d{8,14})\b/i.exec(text)?.[1] ?? '';
    const evidence = [
      { field: 'brand', quote: brand }, { field: 'model', quote: model },
      { field: 'sku', quote: sku }, { field: 'gtin', quote: gtin },
    ].filter(x => x.quote && text.includes(x.quote));
    return validateExtraction({ products: [{ brand, model, sku, gtin, aliases: [] }],
      hazard: notice.hazard ?? '', remedies: [], confidence: evidence.length ? 0.96 : 0.2, evidence,
    }, notice);
  }

  async draftNotice(input: NoticeDraftInput, language: string): Promise<string> {
    const headings: Record<string, string> = { en: 'Product safety recall', fr: 'Rappel de produit pour des raisons de sécurité', es: 'Retirada de producto por seguridad', de: 'Produktsicherheitsrückruf' };
    const stop: Record<string, string> = { en: 'Stop using this product immediately.', fr: 'Cessez immédiatement d’utiliser ce produit.', es: 'Deje de usar este producto inmediatamente.', de: 'Verwenden Sie dieses Produkt sofort nicht mehr.' };
    const heading = headings[language];
    if (!heading) throw new Error('MANUAL_REVIEW: unsupported language');
    return [heading, `${input.brand} ${input.productName}`, input.identifiers.join(', '), input.imageReference,
      input.soldWhere, input.soldWhen, input.soldBy, input.hazard, stop[language],
      input.remedies.join(', '), input.contact].filter(Boolean).join('\n');
  }
}
