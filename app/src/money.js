// Money is compared and passed around in whole cents (integers), never as floating-point.
// Accepts a number (500.5), or a NUMERIC string from Postgres ("500.50").
// Request amounts are validated to at most 2 decimals, so this rounding is exact.
export function toCents(value) {
  return Math.round(Number(value) * 100);
}