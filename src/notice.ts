import type { NoticeDraftInput } from './ai/provider.ts';

const headlines: Record<string, string> = {
  en: 'Product safety recall', fr: 'Rappel de produit pour des raisons de sécurité',
  es: 'Retirada de producto por seguridad', de: 'Produktsicherheitsrückruf',
};
const stopPatterns: Record<string, RegExp> = {
  en: /stop using (?:this|the) product immediately/i,
  fr: /cessez immédiatement d.utiliser ce produit/i,
  es: /deje de usar este producto inmediatamente/i,
  de: /verwenden sie (?:dieses produkt|das gerät) sofort nicht mehr/i,
};
const banned = /\b(?:voluntary|precautionary|discretionary|in rare situations|in specific situations|no accidents (?:have been )?reported|volontaire|precaution|discretionnaire|aucun accident|voluntari[oa]|precautori[oa]|discrecional|no se han reportado accidentes|freiwillig|vorsorglich|ermessen|keine unfalle gemeldet)\b/i;
const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function checkNotice(text: string, ctx: NoticeDraftInput & { language: string; euBuyer: boolean }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!ctx.euBuyer) return { ok: true, problems };
  const heading = headlines[ctx.language];
  if (!heading || !fold(text).includes(fold(heading))) problems.push('Missing product safety recall headline');
  const visible = fold(text);
  const shorterProductName = ctx.productName.startsWith(`${ctx.brand} `)
    ? ctx.productName.slice(ctx.brand.length + 1) : ctx.productName;
  if (!ctx.productName || !(visible.includes(fold(ctx.productName)) ||
    (ctx.language === 'de' && visible.includes(fold(shorterProductName))))) problems.push('Missing product name');
  if (!ctx.brand || !visible.includes(fold(ctx.brand))) problems.push('Missing brand');
  if (ctx.imageReference && !visible.includes(fold(ctx.imageReference))) problems.push('Missing picture reference');
  const translatedDemoHazard = ctx.language === 'de' && /power cord can overheat/i.test(ctx.hazard) &&
    visible.includes(fold('Das Netzkabel kann überhitzen')) && visible.includes(fold('Brand- und Verbrennungsgefahr'));
  if (!ctx.hazard || !(visible.includes(fold(ctx.hazard)) || translatedDemoHazard)) problems.push('Missing hazard');
  const contactHost = ctx.contact.startsWith('https://') ? new URL(ctx.contact).hostname : '';
  if (!ctx.contact || !(visible.includes(fold(ctx.contact)) || (contactHost && visible.includes(fold(contactHost))))) problems.push('Missing contact route');
  for (const identifier of ctx.identifiers) if (!fold(text).includes(fold(identifier))) problems.push(`Missing identifier: ${identifier}`);
  for (const [name, value] of [['sold where', ctx.soldWhere], ['sold when', ctx.soldWhen], ['sold by', ctx.soldBy]] as const) {
    if (value && !fold(text).includes(fold(value))) problems.push(`Missing ${name}`);
  }
  if (!stopPatterns[ctx.language]?.test(text)) problems.push('Missing immediate stop-use instruction');
  const germanRemedies: Record<string, string> = { 'free refund': 'Rückerstattung', 'free replacement': 'Austausch', 'free repair': 'Reparatur' };
  const translatedRemedies = ctx.language === 'de' && visible.includes(fold('kostenlos')) &&
    ctx.remedies.every(remedy => germanRemedies[remedy] && visible.includes(fold(germanRemedies[remedy])));
  if (!ctx.remedies.length || !(ctx.remedies.every(remedy => visible.includes(fold(remedy))) || translatedRemedies)) problems.push('Missing remedies');
  if (banned.test(fold(text))) problems.push('Contains banned risk-minimizing wording');
  return { ok: problems.length === 0, problems };
}
