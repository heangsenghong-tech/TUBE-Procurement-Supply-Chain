// Money arithmetic in integer ten-thousandths, so totals match the numeric(14,4) columns exactly.
const SCALE = 10_000;

export const toUnits = (n: number) => Math.round(n * SCALE);
export const fromUnits = (u: number) => u / SCALE;

export function lineAmount(qty: number, unitPrice: number) {
  // qty has at most 3 decimals and price 4; round the product to 4 decimals.
  return fromUnits(Math.round(Math.round(qty * 1000) * toUnits(unitPrice) / 1000));
}

export function sum(values: number[]) {
  return fromUnits(values.reduce((s, v) => s + toUnits(v), 0));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
