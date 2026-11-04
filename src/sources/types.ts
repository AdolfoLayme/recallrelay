export type RecallNotice = {
  id: string;
  source: 'DEMO' | 'CPSC' | 'HEALTH_CANADA' | 'GOV_UK' | 'EU_SAFETY_GATE' | 'OECD_GLOBAL_RECALLS';
  country: string;
  publishedAt: string;
  title: string;
  rawText: string;
  url: string;
  language: string;
  imageUrls: string[];
  hazard?: string;
  identifiers: string[];
  soldOnline?: boolean;
};

export const objects = (input: unknown): Record<string, unknown>[] => Array.isArray(input) ? input.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)) : [];
export const obj = (input: unknown): Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
export const str = (input: unknown): string => typeof input === 'string' ? input : '';
