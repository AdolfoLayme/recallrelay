import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export type Config = {
  paypalMode: 'fake' | 'sandbox';
  paypalClientId?: string;
  paypalClientSecret?: string;
  paypalWebhookId?: string;
  linkSigningSecret: string;
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiMaxCallsPerSession: number;
  allowedOrigins: string[];
  production: boolean;
  databasePath: string;
};

const positiveInt = z.coerce.number().int().positive();

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const paypalMode = z.enum(['fake', 'sandbox']).parse(env.PAYPAL_MODE ?? 'fake');
  if (paypalMode === 'sandbox') {
    for (const name of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'LINK_SIGNING_SECRET']) {
      if (!env[name]) throw new Error(`${name} is required in sandbox mode`);
    }
  }
  return {
    paypalMode,
    paypalClientId: env.PAYPAL_CLIENT_ID,
    paypalClientSecret: env.PAYPAL_CLIENT_SECRET,
    paypalWebhookId: env.PAYPAL_WEBHOOK_ID,
    linkSigningSecret: env.LINK_SIGNING_SECRET || randomBytes(32).toString('hex'),
    aiBaseUrl: env.AI_BASE_URL,
    aiApiKey: env.AI_API_KEY,
    aiModel: env.AI_MODEL,
    aiMaxCallsPerSession: positiveInt.parse(env.AI_MAX_CALLS_PER_SESSION ?? '20'),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean),
    production: env.NODE_ENV === 'production',
    databasePath: env.DATABASE_PATH ?? 'recallrelay.db',
  };
}

export function redactLog(value: unknown): string {
  const sanitize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sanitize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, field]) => [key,
      /authorization|client_secret|access_token|email|token|api_key/i.test(key) ? '[REDACTED]' : sanitize(field)]));
    if (typeof item === 'string') return item
      .replace(/Bearer\s+\S+/gi, '[REDACTED]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[REDACTED]');
    return item;
  };
  return JSON.stringify(sanitize(value));
}
