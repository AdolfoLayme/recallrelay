import type { ExtractedProduct, Order, OrderMatch } from './types.ts';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function matchOrder(products: ExtractedProduct[], order: Order): OrderMatch {
  let score = 0;
  let reason = 'No sufficiently reliable identifier';
  const lineSkus: string[] = [];
  for (const line of order.lines) {
    let lineScore = 0;
    let lineReason = '';
    for (const product of products) {
      let candidate = 0;
      let candidateReason = '';
      if ((product.gtin && line.gtin && product.gtin === line.gtin) || (product.sku && product.sku === line.sku)) {
        candidate = 1;
        candidateReason = 'Exact GTIN or SKU';
      } else {
        const brand = normalize(product.brand);
        const model = normalize(product.model);
        const name = normalize(line.name);
        if (brand && model && name === `${brand} ${model}`) {
          candidate = 0.95;
          candidateReason = 'Exact brand and model';
        } else if (brand && model && name.includes(brand) && name.includes(model)) {
          candidate = 0.85;
          candidateReason = 'Brand and model in item name';
        } else if (product.sku && line.sku && product.sku !== line.sku &&
          product.sku.includes('-') && product.sku.slice(0, product.sku.lastIndexOf('-') + 1) === line.sku.slice(0, line.sku.lastIndexOf('-') + 1)) {
          candidate = 0.72;
          candidateReason = 'Related SKU family; manual review required';
        }
      }
      if (candidate > lineScore) { lineScore = candidate; lineReason = candidateReason; }
    }
    if (lineScore >= 0.85) lineSkus.push(line.sku);
    if (lineScore > score) { score = lineScore; reason = lineReason; }
  }
  return { score, lineSkus, reason };
}
