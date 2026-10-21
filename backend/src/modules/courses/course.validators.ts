/**
 * Shared validation helpers used by both request schemas and the publishing
 * rules. Keeping them independent from Zod lets the publish readiness check
 * re-validate stored/legacy rows without importing the request layer.
 */

/**
 * Accept only absolute http(s) URLs with a usable host.
 *
 * The prefix check requires the canonical `//` form and rejects other schemes.
 * The WHATWG parser then rejects malformed input that a prefix-only check would
 * let through, such as `https://`, invalid hosts or out-of-range ports.
 */
export function isValidHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      /[a-z0-9]/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/** BCP 47-shaped language tag used by the course metadata. */
export function isValidLanguage(value: string): boolean {
  return /^[a-z]{2}(-[A-Za-z]{2,8})?$/.test(value);
}

/**
 * Active ISO 4217 codes supported by the runtime's ICU data. Checking
 * membership rejects syntactically valid but non-existent codes such as `ZZZ`.
 */
const ISO_4217_CURRENCIES = new Set<string>(
  Intl.supportedValuesOf('currency'),
);

export function isValidCurrency(value: string): boolean {
  return ISO_4217_CURRENCIES.has(value);
}
