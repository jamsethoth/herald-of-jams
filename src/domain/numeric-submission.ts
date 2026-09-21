import type { NumericParseResult } from "./types.js";

const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER);

export function parseNumericSubmission(content: string): NumericParseResult {
  if (!/^[0-9]+$/.test(content)) {
    return { kind: "conversation" };
  }

  const normalized = content.replace(/^0+/, "") || "0";
  if (
    normalized.length > MAX_SAFE_INTEGER_DIGITS.length ||
    (normalized.length === MAX_SAFE_INTEGER_DIGITS.length &&
      normalized > MAX_SAFE_INTEGER_DIGITS)
  ) {
    return { kind: "out_of_range", digits: content };
  }

  return { kind: "safe_integer", digits: content, value: Number(normalized) };
}
