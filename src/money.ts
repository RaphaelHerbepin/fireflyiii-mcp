/**
 * Exact decimal arithmetic on monetary strings, in BigInt.
 *
 * Firefly III reports amounts as strings precisely so they survive intact; parsing them into
 * JavaScript numbers reintroduces the error the strings were chosen to avoid. Summing two thousand
 * `'0.01'` values as floats gives 20.000000000000306, and this server is expected to be exact to the
 * cent over eighteen months of transactions.
 *
 * No dependency: the operation set is parse, rescale, add, subtract, negate, abs, compare, format, and
 * one ratio for percentages. There is no division beyond basis points, no roots, no arbitrary
 * precision to manage. A 32 kB library for `+` would not be proportionate in a package that carries
 * two runtime dependencies on purpose.
 *
 * The scale is read from the string rather than taken from `currency_decimal_places`. Firefly
 * currencies declare anywhere from 0 to 10 decimal places, and that field is not always present on a
 * split; the string already states its own precision, so correctness never depends on metadata being
 * there or being honest. `currency_decimal_places` is then only ever a formatting choice.
 */

/** A decimal number as an integer and a power-of-ten scale: `{ units: 1234n, scale: 2 }` is 12.34. */
export interface Money {
  units: bigint;
  scale: number;
}

export class MoneyParseError extends Error {
  constructor(value: string) {
    super(`Cannot parse "${value}" as a decimal amount.`);
    this.name = 'MoneyParseError';
  }
}

const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

export function parseMoney(value: string): Money {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) throw new MoneyParseError(value);

  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);

/**
 * Restates a value at a different scale.
 *
 * Scaling down throws when digits would be lost rather than rounding. Rounding here is how a total
 * over thousands of rows ends up a cent or two off with nothing to point at.
 */
export function rescaleMoney(money: Money, scale: number): Money {
  if (scale === money.scale) return money;
  if (scale > money.scale) {
    return { units: money.units * pow10(scale - money.scale), scale };
  }
  const divisor = pow10(money.scale - scale);
  if (money.units % divisor !== 0n) {
    throw new Error(`Rescaling ${formatMoney(money)} from scale ${money.scale} to ${scale} would lose precision.`);
  }
  return { units: money.units / divisor, scale };
}

/** Brings two values to a common scale, always the greater of the two, so neither loses digits. */
function align(a: Money, b: Money): [Money, Money, number] {
  const scale = Math.max(a.scale, b.scale);
  return [rescaleMoney(a, scale), rescaleMoney(b, scale), scale];
}

export function addMoney(a: Money, b: Money): Money {
  const [x, y, scale] = align(a, b);
  return { units: x.units + y.units, scale };
}

export function subMoney(a: Money, b: Money): Money {
  const [x, y, scale] = align(a, b);
  return { units: x.units - y.units, scale };
}

export const negateMoney = (money: Money): Money => ({ units: -money.units, scale: money.scale });

export const absMoney = (money: Money): Money => ({
  units: money.units < 0n ? -money.units : money.units,
  scale: money.scale,
});

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  if (x.units < y.units) return -1;
  if (x.units > y.units) return 1;
  return 0;
}

export const zeroMoney = (scale = 2): Money => ({ units: 0n, scale });

export function sumMoney(values: readonly string[]): Money {
  let total = zeroMoney(0);
  for (const value of values) total = addMoney(total, parseMoney(value));
  return total;
}

/**
 * Applies a transaction type's direction to an amount.
 *
 * The API always reports `amount` as a positive string and puts direction in `type`. Encoding that
 * once, here, is the difference between an aggregation that is right and one that is wrong on every
 * row. A transfer is positive because its direction depends on which account you look from, and the
 * caller decides that, not this function.
 */
export function signedAmount(type: string, amount: string): Money {
  const money = parseMoney(amount);
  const magnitude = absMoney(money);
  return type.toLowerCase() === 'withdrawal' ? negateMoney(magnitude) : magnitude;
}

export function formatMoney(money: Money, decimalPlaces?: number): string {
  const target = decimalPlaces ?? money.scale;
  const scaled =
    target >= money.scale
      ? { units: money.units * pow10(target - money.scale), scale: target }
      : rescaleMoney(money, target);

  const negative = scaled.units < 0n;
  const digits = (negative ? -scaled.units : scaled.units).toString().padStart(target + 1, '0');
  const whole = digits.slice(0, digits.length - target) || '0';
  const fraction = target > 0 ? `.${digits.slice(digits.length - target)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * `part` as a share of `total`, in basis points (hundredths of a percent), truncated.
 *
 * Basis points keep the result an integer, so percentages can be summed and compared without
 * reintroducing floats at the last step. Returns null when the total is zero — a share of nothing is
 * undefined, and 0 would be a claim rather than an absence.
 */
export function basisPoints(part: Money, total: Money): number | null {
  const [p, t] = align(part, total);
  if (t.units === 0n) return null;
  return Number((p.units * 10000n) / t.units);
}

/**
 * Percentages, in basis points, that sum to exactly 10000.
 *
 * Rounding each share independently produces sets like 33.33 + 33.33 + 33.33 = 99.99, which reads as
 * missing data and invites a model to hunt for the gap. The largest-remainder method hands the
 * leftover basis points to the shares with the biggest truncation error.
 */
export function largestRemainderPercentages(parts: readonly Money[], total: Money): number[] {
  const aligned = parts.map((p) => align(p, total)[0]);
  const [, scaledTotal] = align(parts[0] ?? zeroMoney(), total);
  if (scaledTotal.units === 0n) return parts.map(() => 0);

  const exact = aligned.map((p) => (p.units * 10000n) / scaledTotal.units);
  const remainders = aligned.map((p, i) => ((p.units * 10000n) % scaledTotal.units) - 0n * BigInt(i));

  const result = exact.map(Number);
  let allocated = result.reduce((a, b) => a + b, 0);

  // Hand out what truncation left over, largest remainder first.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));

  for (const { index } of order) {
    if (allocated >= 10000) break;
    result[index] += 1;
    allocated += 1;
  }
  return result;
}
