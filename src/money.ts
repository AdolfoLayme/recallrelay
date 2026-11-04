const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'TWD', 'VND', 'CLP', 'ISK', 'HUF']);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

export function toPayPalAmount(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Amount must be nonnegative integer minor units');
  const decimals = currencyDecimals(currency);
  if (decimals === 0) return String(minor);
  const whole = Math.floor(minor / 100);
  return `${whole}.${String(minor % 100).padStart(2, '0')}`;
}

export function fromPayPalAmount(value: string, currency: string): number {
  const decimals = currencyDecimals(currency);
  const match = decimals === 0 ? /^(0|[1-9]\d*)$/.exec(value) : /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error('Invalid PayPal amount');
  const amount = Number(match[1]) * (decimals === 0 ? 1 : 100) + (decimals === 0 ? 0 : Number((match[2] ?? '').padEnd(2, '0')));
  if (!Number.isSafeInteger(amount)) throw new Error('Amount exceeds safe integer range');
  return amount;
}
