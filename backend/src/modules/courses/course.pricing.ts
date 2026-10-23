/**
 * Shared course pricing predicate.
 *
 * A course is free only when its stored price is exactly zero, or when a
 * legacy published row has no price at all. Negative, non-finite or otherwise
 * invalid legacy prices are deliberately not treated as free, so corrupt data
 * cannot create an accidental free-enrollment bypass while the public catalog
 * still renders the course as paid.
 */
export function isCourseFree(
  priceMinor: number | null | undefined,
): boolean {
  return (priceMinor ?? 0) === 0;
}
