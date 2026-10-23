/**
 * Turn an arbitrary title into a URL-safe ASCII slug.
 *
 * Non-latin titles (for example fully-Arabic titles) produce an empty base;
 * callers are expected to fall back to a random identifier.
 */
export function slugify(input: string, maxLength: number): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}
