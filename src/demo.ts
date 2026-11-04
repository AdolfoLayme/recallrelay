import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Order } from './types.ts';
import type { RecallNotice } from './sources/types.ts';

export const DEMO_RECALL_ID = 'demo-lumen-mini-heater';
export const DEMO_REFERENCE_TIME = Date.parse('2026-11-03T09:12:00Z');
export const DEMO_SKU = 'HP-LMH-015';
export const DEMO_BUDGETS = { USD: 30000, CAD: 40000, GBP: 15000, AUD: 20000, EUR: 25000 };
export const DEMO_NOTICE_WARNING_DE = 'Dieser Rückruf erfolgt vorsorglich.';
export const DEMO_NOTICE_DRAFT_DE = [
  'Produktsicherheitsrückruf',
  'Lumen Mini Space Heater, Modell HP-LMH-015. Verkauft online von Januar bis Oktober 2026 von Harbor & Pine.',
  'Das Netzkabel kann überhitzen. Es besteht Brand- und Verbrennungsgefahr.',
  'Verwenden Sie das Gerät sofort nicht mehr.',
  'Wählen Sie Ihre Abhilfe: Rückerstattung oder Austausch. Beides ist für Sie kostenlos.',
  'Kostenlose Hilfe online: help.harborpine.example',
].join('\n\n');
export const DEMO_EXECUTION_ORDER = ['0994', '1042', '1019', '1071', '1103', '0871', '0866'];

export function createDemoSession(db: DatabaseSync, now = Date.now(), demoAsOf?: number): string {
  const sessionId = randomUUID();
  const noticeDate = DEMO_REFERENCE_TIME;
  const recall: RecallNotice & { fileNumber: string; supplier: string; demoAsOf?: string; planSummary: string; planNote: string;
    buyerDisplayName: string; buyerStopTitle: string; buyerInstruction: string; buyerSoldText: string; buyerHelpText: string;
    buyerOptions: string[]; fileSummary: string; noticeCaption: string; matchSummary: string; saleBlockedAt: string;
    runSupplierIntro: string; reviewDescription: string; reviewProductName: string; reviewSold: string;
    reviewScoreText: string;
    displayFacts: { hazard: string; remedy: string; sold: string } } = {
    id: DEMO_RECALL_ID, source: 'DEMO', country: 'US', publishedAt: new Date(noticeDate).toISOString(),
    ...(demoAsOf === undefined ? {} : { demoAsOf: new Date(demoAsOf).toISOString() }),
    fileNumber: 'RR-2026-0417', supplier: 'Kestrel Appliance Co.',
    planSummary: 'Lumen Mini Space Heater. SKU HP-LMH-015. 12 orders matched. Nothing moves until you approve.',
    planNote: 'EUR 208.00 is reserved until two EU buyers choose a remedy. JPY 12,800 is released, not spent. Two orders stay in review and are not in this plan.',
    buyerDisplayName: 'Lumen Mini Space Heater', buyerStopTitle: 'Stop using this heater now.',
    buyerInstruction: 'Unplug it. The power cord can overheat and cause a fire or burns.',
    buyerSoldText: 'Sold online by Harbor & Pine from January to October 2026.',
    buyerHelpText: 'Free help: help.harborpine.example',
    buyerOptions: ['refund', 'replacement'],
    fileSummary: 'Lumen Mini Space Heater. Fire and burn hazard.',
    noticeCaption: 'Sample notice, CPSC format.',
    matchSummary: '11 exact matches on SKU. 1 weak match. 2 orders go to review.',
    saleBlockedAt: '09:14',
    runSupplierIntro: 'Kestrel Appliance Co. made this heater. Send one PayPal invoice per currency for what you paid out.',
    reviewDescription: 'The name is close, but the SKU differs and the notice names only one model.',
    reviewProductName: 'Lumen Mini Space Heater', reviewSold: 'Jan to Oct 2026',
    reviewScoreText: 'Match score 0.72. Below 0.85 always comes here.',
    displayFacts: { hazard: 'Fire, burn', remedy: 'Full refund', sold: 'Online, Jan to Oct 2026' },
    title: 'Harbor & Pine Lumen Mini Space Heater recall',
    rawText: 'Harbor & Pine recalls about 3,400 Lumen Mini Space Heaters, model HP-LMH-015. The power cord can overheat, posing fire and burn hazards. Consumers should immediately stop using the\nrecalled heaters and contact Harbor & Pine for a full\nrefund. The heaters were sold online from January 2026 through October 2026 for about $129.',
    url: 'https://example.test/fictional-recall', language: 'en', imageUrls: [],
    hazard: 'The power cord can overheat, posing fire and burn hazards.', identifiers: [DEMO_SKU],
  };
  const otherNotices = [
    ['EU_SAFETY_GATE','Safety Gate','EU','Baby sleep pillow, cat print','Suffocation',0],
    ['GOV_UK','OPSS','GB','USB power adaptor, 65 W','Electric shock',1],
    ['OECD_GLOBAL_RECALLS','ACCC','AU','LED solar garden lamp','Button battery',4],
    ['HEALTH_CANADA','Health Canada','CA','LED costume wings','Ingestion',5],
    ['CPSC','CPSC','US','Folding step stool','Fall',5],
    ['OECD_GLOBAL_RECALLS','OECD','TW','Portable charger, 20,000 mAh','Fire',15],
    ['GOV_UK','OPSS','GB','Children’s night light','Burn',18],
  ] as const;
  type Scenario = { id: string; country: string; currency: string; age: number; amount: number; status?: Order['status']; shipped?: boolean; refunded?: number; sku?: string; name?: string };
  const scenarios: Scenario[] = [
    { id: '1042', country: 'US', currency: 'USD', age: 12, amount: 12900 },
    { id: '1071', country: 'AU', currency: 'AUD', age: 31, amount: 18900 },
    { id: '1019', country: 'CA', currency: 'CAD', age: 150, amount: 17900 },
    { id: '0994', country: 'GB', currency: 'GBP', age: 178, amount: 9900 },
    { id: '0871', country: 'US', currency: 'USD', age: 212, amount: 12900 },
    { id: '0866', country: 'CA', currency: 'CAD', age: 241, amount: 17900 },
    { id: '1103', country: 'JP', currency: 'JPY', age: 2, amount: 12800, status: 'AUTHORIZED', shipped: false },
    { id: '1051', country: 'DE', currency: 'EUR', age: 40, amount: 11900 },
    { id: '1060', country: 'FR', currency: 'EUR', age: 28, amount: 11900, status: 'PARTIALLY_REFUNDED', refunded: 3000 },
    { id: '1088', country: 'GB', currency: 'GBP', age: 9, amount: 9900, status: 'AUTHORIZED', shipped: true },
    { id: '1077', country: 'US', currency: 'USD', age: 17, amount: 12900, sku: 'HP-LMH-020', name: 'Lumen Heater Mini Pro' },
    { id: '1038', country: 'US', currency: 'USD', age: 96, amount: 12900, status: 'REFUNDED', refunded: 12900 },
  ];
  const orders: (Order & { payoutEmail: string })[] = scenarios.map((scenario, index) => {
    const authorized = scenario.status === 'AUTHORIZED';
    return {
      id: scenario.id, gateway: 'fake', merchantId: 'harbor-pine', buyerName: `Example Buyer ${index + 1}`,
      buyerEmail: `buyer${index + 1}@example.test`, payoutEmail: `buyer${index + 1}@example.test`,
      buyerCountry: scenario.country, language: scenario.country === 'DE' ? 'de' : scenario.country === 'FR' ? 'fr' : 'en',
      currency: scenario.currency, status: scenario.status ?? 'CAPTURED', shipped: scenario.shipped ?? true,
      paidAt: new Date((demoAsOf ?? now) - scenario.age * 86_400_000).toISOString(),
      ...(authorized ? { authorizationId: `fake-auth-${sessionId}-${scenario.id}` } : { captureId: `fake-cap-${sessionId}-${scenario.id}` }),
      refundedMinor: scenario.refunded ?? 0,
      lines: [{ sku: scenario.sku ?? DEMO_SKU, name: scenario.name ?? 'Harbor & Pine Lumen Mini Space Heater',
        quantity: 1, unitPriceMinor: scenario.amount, taxMinor: 0 }],
    };
  });
  orders.find(order => order.id === '1071')!.lines.push({ sku: 'HP-LAMP-001', name: 'Harbor & Pine Desk Lamp', quantity: 1, unitPriceMinor: 4000, taxMinor: 0 });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO sessions(id,expires_at) VALUES(?,?)').run(sessionId, now + 2 * 60 * 60 * 1000);
    db.prepare('INSERT INTO recalls(id,session_id,body_json) VALUES(?,?,?)').run(recall.id, sessionId, JSON.stringify(recall));
    for (const [source,sourceLabel,country,title,hazard,daysAgo] of otherNotices) {
      const sample: RecallNotice & {sourceLabel:string;demoSample:boolean} = {
        id:`demo-sample-${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`, source:'DEMO', sourceLabel,
        demoSample:true, country, publishedAt:new Date(noticeDate-daysAgo*86_400_000).toISOString(), title,
        rawText:`Fictional sample notice for ${title}. Hazard: ${hazard}.`, url:'https://example.test/fictional-recall',
        language:'en', imageUrls:[], hazard, identifiers:[],
      };
      db.prepare('INSERT INTO recalls(id,session_id,body_json) VALUES(?,?,?)').run(sample.id,sessionId,JSON.stringify(sample));
    }
    const sourceDetails = [
      ['CPSC', 'CPSC', 'United States', 12],
      ['HEALTH_CANADA', 'Health Canada', 'Canada', 12],
      ['GOV_UK', 'GOV.UK', 'United Kingdom', 12],
      ['EU_SAFETY_GATE', 'Safety Gate', 'European Union', 12],
      ['OECD_GLOBAL_RECALLS', 'OECD portal', 'AU, KR, JP, TW', 180],
    ] as const;
    for (const [sortOrder,[source,displayName,region,ageMinutes]] of sourceDetails.entries())
      db.prepare('INSERT INTO source_status(session_id,source,body_json,refreshed_at) VALUES(?,?,?,?)')
        .run(sessionId,source,JSON.stringify({ok:true,count:otherNotices.filter(row=>row[0]===source).length,
          sample:true,displayName,region,sortOrder,updatedLabel:'Updated 09:12.',
          refreshedAt:new Date(now-ageMinutes*60_000).toISOString()}),now-ageMinutes*60_000);
    const insert = db.prepare('INSERT INTO orders(id,session_id,body_json) VALUES(?,?,?)');
    for (const order of orders) insert.run(order.id, sessionId, JSON.stringify(order));
    const addReview = db.prepare('INSERT INTO review_queue(id,session_id,kind,status,body_json) VALUES(?,?,?,?,?)');
    addReview.run(randomUUID(), sessionId, 'ORDER_MATCH', 'PENDING', JSON.stringify({
      recallId: DEMO_RECALL_ID, orderId: '1077', reason: 'Weak product match', score: 0.72, amountMinor: 12900, currency: 'USD',
    }));
    addReview.run(randomUUID(), sessionId, 'ORDER_MATCH', 'PENDING', JSON.stringify({
      recallId: DEMO_RECALL_ID, orderId: '1088', reason: 'Hold already shipped', amountMinor: 9900, currency: 'GBP',
    }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return sessionId;
}

export function cleanupExpiredSessions(db: DatabaseSync, now = Date.now()): number {
  const rows = db.prepare('SELECT id FROM sessions WHERE expires_at <= ? AND cleaned_at IS NULL').all(now) as { id: string }[];
  let cleaned = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { id } of rows) {
      if (db.prepare('SELECT 1 FROM remedy_links WHERE session_id=? AND expires_at>? LIMIT 1').get(id, now)) continue;
      for (const table of ['outbox', 'approvals', 'plan_order', 'store_orders', 'remedy_links', 'fulfilment_tasks', 'supplier_invoices', 'supplier_invoice_approvals', 'plans', 'webhooks', 'remedy_choices', 'blocklist', 'review_queue', 'notice_deliveries', 'orders', 'recalls', 'source_status'])
        db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
      const audit = db.prepare('SELECT 1 FROM audit_log WHERE session_id=? LIMIT 1').get(id);
      if (audit) db.prepare('UPDATE sessions SET cleaned_at=? WHERE id=?').run(now, id);
      else db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      cleaned++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return cleaned;
}
