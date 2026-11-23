/**
 * BigInt-safe amount formatting utilities for Cypher GridPay.
 *
 * All monetary math is performed with `bigint` arithmetic to avoid IEEE-754
 * floating point precision loss (Stellar i128 amounts routinely exceed
 * `Number.MAX_SAFE_INTEGER` = 2^53 - 1).
 *
 * This module intentionally never converts token amounts to `number`.
 */

/** Maximum safe integer for JavaScript `number` (2^53 - 1). */
export const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Default number of decimal places used when formatting display strings. */
export const DEFAULT_DISPLAY_DECIMALS = 7;

/** Characters that spreadsheet applications interpret as formula prefixes. */
const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

/**
 * Error thrown when an amount string cannot be parsed as a valid decimal.
 */
export class AmountParseError extends Error {
  constructor(message: string, public readonly input: unknown) {
    super(message);
    this.name = 'AmountParseError';
  }
}

/**
 * Normalize a raw amount input into a `bigint`.
 *
 * Accepts `bigint`, integer `number` (must be a safe integer), or a string of
 * digits with an optional leading sign. Rejects anything that would require
 * floating point interpretation.
 */
export function toBigIntAmount(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new AmountParseError(
        `Amount must be an integer, received non-integer number: ${value}`,
        value,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new AmountParseError(
        `Amount ${value} exceeds Number.MAX_SAFE_INTEGER; pass a bigint or string instead`,
        value,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new AmountParseError(
        `Amount string must contain only an optional sign and digits: "${value}"`,
        value,
      );
    }
    return BigInt(trimmed);
  }
  throw new AmountParseError(
    `Unsupported amount type: ${typeof value}`,
    value,
  );
}

/**
 * Compute `10 ** decimals` as a `bigint`.
 */
export function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountParseError(
      `Decimals must be a non-negative integer, received: ${decimals}`,
      decimals,
    );
  }
  // Guard against pathological exponents that would exhaust memory.
  if (decimals > 77) {
    throw new AmountParseError(
      `Decimals ${decimals} exceeds supported maximum of 77`,
      decimals,
    );
  }
  return BigInt(10) ** BigInt(decimals);
}

/**
 * Split a raw integer amount into its integer and fractional parts as strings.
 *
 * The fractional part is truncated (never rounded) to `displayDecimals`.
 */
export function splitAmount(
  rawAmount: bigint | number | string,
  decimals: number,
  displayDecimals: number = decimals,
): { negative: boolean; integer: string; fraction: string } {
  const amount = toBigIntAmount(rawAmount);
  if (!Number.isInteger(displayDecimals) || displayDecimals < 0) {
    throw new AmountParseError(
      `displayDecimals must be a non-negative integer, received: ${displayDecimals}`,
      displayDecimals,
    );
  }

  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const scale = pow10(decimals);

  const integerPart = absolute / scale;
  const remainder = absolute % scale;

  // Pad the remainder to `decimals` digits, then truncate to displayDecimals.
  const paddedRemainder = remainder.toString().padStart(decimals, '0');
  const truncatedFraction = paddedRemainder.slice(0, displayDecimals);

  return {
    negative,
    integer: integerPart.toString(),
    fraction: truncatedFraction,
  };
}

/**
 * Format a raw token amount (in smallest units) as a human-readable decimal
 * string. Uses BigInt arithmetic exclusively and truncates rather than rounds.
 *
 * @example
 * formatAmount(1234567890n, 7) // "123.456789"
 * formatAmount(1n, 7)          // "0.0000001"
 * formatAmount(-5n, 2)         // "-0.05"
 */
export function formatAmount(
  rawAmount: bigint | number | string,
  decimals: number,
  options: {
    /** Number of fractional digits to display. Defaults to `decimals`. */
    displayDecimals?: number;
    /** Minimum integer digits (zero-padded). Defaults to 0. */
    minIntegerDigits?: number;
    /** Whether to include thousands separators in the integer part. */
    groupThousands?: boolean;
    /** Whether to trim trailing zeros from the fractional part. */
    trimTrailingZeros?: boolean;
  } = {},
): string {
  const {
    displayDecimals = decimals,
    minIntegerDigits = 0,
    groupThousands = false,
    trimTrailingZeros = false,
  } = options;

  const { negative, integer, fraction } = splitAmount(
    rawAmount,
    decimals,
    displayDecimals,
  );

  let integerDisplay = integer;
  if (minIntegerDigits > 0) {
    integerDisplay = integerDisplay.padStart(minIntegerDigits, '0');
  }
  if (groupThousands) {
    integerDisplay = groupThousandsString(integerDisplay);
  }

  let fractionDisplay = fraction;
  if (trimTrailingZeros) {
    fractionDisplay = fractionDisplay.replace(/0+$/, '');
  }

  const sign = negative && (integer !== '0' || fractionDisplay !== '') ? '-' : '';
  const body =
    fractionDisplay.length > 0
      ? `${integerDisplay}.${fractionDisplay}`
      : integerDisplay;

  return `${sign}${body}`;
}

/**
 * Insert thousands separators into a digit-only string.
 */
function groupThousandsString(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a raw token amount with a currency symbol prefix.
 *
 * @example
 * formatCurrency(1234567890n, 7, 'XLM') // "XLM 123.456789"
 */
export function formatCurrency(
  rawAmount: bigint | number | string,
  decimals: number,
  symbol: string,
  options: {
    displayDecimals?: number;
    groupThousands?: boolean;
    trimTrailingZeros?: boolean;
    /** Placement of the symbol relative to the amount. Defaults to "prefix". */
    symbolPosition?: 'prefix' | 'suffix';
    /** Separator between symbol and amount. Defaults to a single space. */
    separator?: string;
  } = {},
): string {
  const {
    symbolPosition = 'prefix',
    separator = ' ',
    ...formatOptions
  } = options;

  const formatted = formatAmount(rawAmount, decimals, formatOptions);
  return symbolPosition === 'prefix'
    ? `${symbol}${separator}${formatted}`
    : `${formatted}${separator}${symbol}`;
}

/**
 * Parse a human-readable decimal string into a raw integer amount (smallest
 * units) using BigInt arithmetic. Extra fractional digits beyond `decimals`
 * are rejected to prevent silent precision loss.
 */
export function parseAmount(
  decimalString: string,
  decimals: number,
): bigint {
  const trimmed = decimalString.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === '' && (match[3] === undefined || match[3] === ''))) {
    throw new AmountParseError(
      `Invalid decimal amount: "${decimalString}"`,
      decimalString,
    );
  }

  const [, sign, integerPart = '', fractionPart = ''] = match;
  if (fractionPart.length > decimals) {
    throw new AmountParseError(
      `Amount "${decimalString}" has more than ${decimals} fractional digits`,
      decimalString,
    );
  }

  const scale = pow10(decimals);
  const paddedFraction = fractionPart.padEnd(decimals, '0');
  const integerValue = BigInt(integerPart === '' ? '0' : integerPart);
  const fractionValue = BigInt(paddedFraction === '' ? '0' : paddedFraction);
  const raw = integerValue * scale + fractionValue;

  return sign === '-' ? -raw : raw;
}

/**
 * Compute a percentage delta between two raw amounts as a display string.
 *
 * Returns `null` when the baseline is zero (percentage change undefined).
 * Uses BigInt arithmetic with fixed-point scaling to avoid floating point
 * drift; the result is truncated to `displayDecimals`.
 */
export function formatPercentageDelta(
  current: bigint | number | string,
  previous: bigint | number | string,
  options: {
    displayDecimals?: number;
    /** Include a leading "+" for positive deltas. Defaults to true. */
    includePlusSign?: boolean;
  } = {},
): string | null {
  const { displayDecimals = 2, includePlusSign = true } = options;
  const currentAmount = toBigIntAmount(current);
  const previousAmount = toBigIntAmount(previous);

  if (previousAmount === BigInt(0)) {
    return null;
  }

  // Scale by 10^(displayDecimals + 2) to retain two extra digits of precision
  // before truncating to the requested display precision.
  const precisionScale = pow10(displayDecimals + 2);
  const hundred = BigInt(100);

  const delta = currentAmount - previousAmount;
  const scaledNumerator = delta * hundred * precisionScale;
  // BigInt division truncates toward zero, matching our truncation policy.
  const scaledResult = scaledNumerator / previousAmount;

  const negative = scaledResult < BigInt(0);
  const absolute = negative ? -scaledResult : scaledResult;
  const divisor = pow10(2);
  const integerPart = absolute / divisor;
  const fractionPart = (absolute % divisor).toString().padStart(2, '0');

  const sign = negative ? '-' : includePlusSign ? '+' : '';
  const fractionDisplay = displayDecimals > 0 ? `.${fractionPart}` : '';
  return `${sign}${integerPart.toString()}${fractionDisplay}%`;
}

/**
 * Format a volume delta for KPI cards, e.g. "+12.34%".
 * Convenience wrapper around {@link formatPercentageDelta}.
 */
export function formatVolumeDelta(
  current: bigint | number | string,
  previous: bigint | number | string,
  displayDecimals: number = 2,
): string | null {
  return formatPercentageDelta(current, previous, { displayDecimals });
}

/**
 * Escape a string for safe insertion into HTML text content or attributes.
 *
 * This is a defense-in-depth helper for free-text fields such as payment
 * `notes` and `metadata`. React already escapes interpolated text, but this
 * helper protects against `dangerouslySetInnerHTML` usage and non-React
 * rendering paths.
 */
export function sanitizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Escape a single CSV field.
 *
 * - Prefixes formula-injection characters (`=`, `+`, `-`, `@`, tab, CR) with a
 *   single quote so spreadsheet applications treat the value as text.
 * - Wraps fields containing commas, quotes, or newlines in double quotes and
 *   doubles any embedded quotes per RFC 4180.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = typeof value === 'string' ? value : String(value);

  // Neutralize spreadsheet formula injection.
  if (text.length > 0 && (CSV_FORMULA_PREFIXES as readonly string[]).includes(text[0])) {
    text = `'${text}`;
  }

  const needsQuoting = /[",\r\n]/.test(text);
  if (needsQuoting) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serialize rows into a CSV string, escaping every field.
 */
export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  options: { lineEnding?: string } = {},
): string {
  const { lineEnding = '\r\n' } = options;
  return rows
    .map((row) => row.map((field) => escapeCsvField(field)).join(','))
    .join(lineEnding);
}