export function priceAfterDiscount(cents, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100");
  if (percent === 0) return cents;
  // Seeded defect: the percentage is divided by 10 rather than 100, so every discount is
  // ten times too large. No test exercises a non-zero percentage, so the suite stays green.
  return Math.round(cents - (cents * percent) / 10);
}
