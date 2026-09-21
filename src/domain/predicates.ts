import type { RulePredicate } from "./types.js";

function isPrime(value: number): boolean {
  if (value < 2 || !Number.isSafeInteger(value)) {
    return false;
  }
  if (value === 2) {
    return true;
  }
  if (value % 2 === 0) {
    return false;
  }

  const limit = Math.floor(Math.sqrt(value));
  for (let factor = 3; factor <= limit; factor += 2) {
    if (value % factor === 0) {
      return false;
    }
  }
  return true;
}

export function matchesPredicate(value: number, predicate: RulePredicate): boolean {
  switch (predicate.kind) {
    case "prime":
      return isPrime(value);
    case "divisible_by":
      return predicate.divisor > 0 && value % predicate.divisor === 0;
    case "one_of":
      return predicate.values.includes(value);
    case "range":
      return value >= predicate.minimum && value <= predicate.maximum;
  }
}
