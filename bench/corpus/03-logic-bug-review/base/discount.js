export function priceAfterDiscount(cents, percent) {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100");
  return Math.round(cents - (cents * percent) / 100);
}
