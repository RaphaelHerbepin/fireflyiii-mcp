import { describe, expect, it } from 'vitest';
import {
  absMoney,
  addMoney,
  basisPoints,
  compareMoney,
  formatMoney,
  largestRemainderPercentages,
  MoneyParseError,
  negateMoney,
  parseMoney,
  rescaleMoney,
  signedAmount,
  subMoney,
  sumMoney,
  zeroMoney,
} from '../money.js';

describe('parseMoney', () => {
  it('reads the scale from the string itself', () => {
    // Correctness must not depend on currency_decimal_places being present or honest — the string
    // already says how precise it is.
    expect(parseMoney('12.345')).toEqual({ units: 12345n, scale: 3 });
    expect(parseMoney('12.34')).toEqual({ units: 1234n, scale: 2 });
    expect(parseMoney('12')).toEqual({ units: 12n, scale: 0 });
  });

  it('handles negatives and explicit plus signs', () => {
    expect(parseMoney('-45.00')).toEqual({ units: -4500n, scale: 2 });
    expect(parseMoney('+45.00')).toEqual({ units: 4500n, scale: 2 });
    expect(parseMoney('-0.01')).toEqual({ units: -1n, scale: 2 });
  });

  it('handles zero in every spelling', () => {
    expect(parseMoney('0').units).toBe(0n);
    expect(parseMoney('0.00').units).toBe(0n);
    expect(parseMoney('-0.00').units).toBe(0n);
  });

  it('handles the ten decimal places Firefly currencies may declare', () => {
    expect(parseMoney('1.0123456789')).toEqual({ units: 10123456789n, scale: 10 });
  });

  it('keeps full precision on values a float would round', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004. This is why amounts are strings.
    expect(formatMoney(addMoney(parseMoney('0.1'), parseMoney('0.2')))).toBe('0.3');
  });

  it('rejects anything that is not a decimal number', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,50', '€5', '1e3', ' ']) {
      expect(() => parseMoney(bad), bad).toThrow(MoneyParseError);
    }
  });
});

describe('rescaleMoney', () => {
  it('scales up exactly', () => {
    expect(rescaleMoney({ units: 1234n, scale: 2 }, 4)).toEqual({ units: 123400n, scale: 4 });
  });

  it('scales down when no digits would be lost', () => {
    expect(rescaleMoney({ units: 123400n, scale: 4 }, 2)).toEqual({ units: 1234n, scale: 2 });
  });

  it('refuses to scale down when it would lose digits', () => {
    // Silently rounding here is how cent discrepancies appear in a total of thousands of rows.
    expect(() => rescaleMoney({ units: 12345n, scale: 3 }, 2)).toThrow(/lose precision/);
  });
});

describe('addMoney and subMoney', () => {
  it('aligns operands on the greater scale', () => {
    expect(addMoney(parseMoney('1.5'), parseMoney('2.25'))).toEqual({ units: 375n, scale: 2 });
  });

  it('subtracts across scales', () => {
    expect(formatMoney(subMoney(parseMoney('10'), parseMoney('0.001')))).toBe('9.999');
  });
});

describe('sumMoney', () => {
  it('sums two thousand hundredths to exactly twenty', () => {
    // The float equivalent lands on 20.000000000000306.
    expect(formatMoney(sumMoney(Array.from({ length: 2000 }, () => '0.01')))).toBe('20.00');
  });

  it('sums mixed scales without drifting', () => {
    expect(formatMoney(sumMoney(['0.1', '0.02', '0.003', '0.0004']))).toBe('0.1234');
  });

  it('returns zero for an empty list', () => {
    expect(sumMoney([]).units).toBe(0n);
  });
});

describe('signedAmount', () => {
  it('makes a withdrawal negative and a deposit positive', () => {
    // The API always reports a positive amount and puts direction in `type`. Any aggregation reading
    // the sign off the amount would be wrong on every single row.
    expect(signedAmount('withdrawal', '45.00').units).toBe(-4500n);
    expect(signedAmount('deposit', '45.00').units).toBe(4500n);
  });

  it('treats a transfer as positive — direction depends on which side you are looking from', () => {
    expect(signedAmount('transfer', '45.00').units).toBe(4500n);
  });

  it('is case-insensitive about the type', () => {
    expect(signedAmount('Withdrawal', '45.00').units).toBe(-4500n);
  });

  it('does not double-negate an already negative amount', () => {
    expect(signedAmount('withdrawal', '-45.00').units).toBe(-4500n);
  });
});

describe('compareMoney, absMoney, negateMoney, zeroMoney', () => {
  it('compares across scales', () => {
    expect(compareMoney(parseMoney('1.5'), parseMoney('1.50'))).toBe(0);
    expect(compareMoney(parseMoney('1.5'), parseMoney('1.51'))).toBe(-1);
    expect(compareMoney(parseMoney('2'), parseMoney('1.99'))).toBe(1);
  });

  it('takes absolute values and negates', () => {
    expect(absMoney(parseMoney('-45.00')).units).toBe(4500n);
    expect(negateMoney(parseMoney('45.00')).units).toBe(-4500n);
  });

  it('produces a zero at a given scale', () => {
    expect(formatMoney(zeroMoney(2))).toBe('0.00');
  });
});

describe('formatMoney', () => {
  it('round-trips through parseMoney', () => {
    for (const value of ['0.00', '1.50', '-45.00', '1234567.89', '0.0001']) {
      expect(formatMoney(parseMoney(value))).toBe(value);
    }
  });

  it('formats to a requested number of decimal places', () => {
    expect(formatMoney(parseMoney('1.5'), 2)).toBe('1.50');
    expect(formatMoney(parseMoney('1'), 3)).toBe('1.000');
  });

  it('keeps the minus sign on values between -1 and 0', () => {
    expect(formatMoney(parseMoney('-0.05'))).toBe('-0.05');
  });
});

describe('basisPoints', () => {
  it('expresses a part of a total in hundredths of a percent', () => {
    expect(basisPoints(parseMoney('25.00'), parseMoney('100.00'))).toBe(2500);
    expect(basisPoints(parseMoney('33.33'), parseMoney('100.00'))).toBe(3333);
  });

  it('returns null rather than dividing by zero', () => {
    expect(basisPoints(parseMoney('1.00'), parseMoney('0.00'))).toBeNull();
  });
});

describe('largestRemainderPercentages', () => {
  it('distributes percentages that sum to exactly 100', () => {
    // Rounding each share independently yields 33.33 × 3 = 99.99, which reads as missing data.
    const parts = ['33.33', '33.33', '33.34'].map(parseMoney);
    const percentages = largestRemainderPercentages(parts, parseMoney('100.00'));
    expect(percentages.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('sums to 100 on a hard case', () => {
    const parts = ['1', '1', '1', '1', '1', '1', '1'].map(parseMoney);
    const percentages = largestRemainderPercentages(parts, parseMoney('7'));
    expect(percentages.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('returns zeros when the total is zero', () => {
    expect(largestRemainderPercentages([parseMoney('0')], parseMoney('0'))).toEqual([0]);
  });
});
