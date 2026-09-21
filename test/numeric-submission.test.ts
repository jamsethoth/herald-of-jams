import { describe, expect, it } from "vitest";

import { parseNumericSubmission } from "../src/domain/numeric-submission.js";
import { matchesPredicate } from "../src/domain/predicates.js";

describe("parseNumericSubmission", () => {
  it.each(["", " ", "-1", "+1", "1.0", "1e3", "12!", "１２"])(
    "treats %j as conversation",
    (content) => {
      expect(parseNumericSubmission(content)).toEqual({ kind: "conversation" });
    },
  );

  it("normalizes leading zeroes after preserving the original digits", () => {
    expect(parseNumericSubmission("001")).toEqual({
      kind: "safe_integer",
      digits: "001",
      value: 1,
    });
  });

  it("accepts the maximum JavaScript safe integer", () => {
    expect(parseNumericSubmission("9007199254740991")).toEqual({
      kind: "safe_integer",
      digits: "9007199254740991",
      value: Number.MAX_SAFE_INTEGER,
    });
  });

  it("rejects a value above the JavaScript safe range", () => {
    expect(parseNumericSubmission("9007199254740992")).toEqual({
      kind: "out_of_range",
      digits: "9007199254740992",
    });
  });

  it("rejects a huge digit string without numeric coercion", () => {
    const digits = "9".repeat(200_000);

    expect(parseNumericSubmission(digits)).toEqual({ kind: "out_of_range", digits });
  });
});

describe("matchesPredicate", () => {
  it.each([
    [2, true],
    [97, true],
    [0, false],
    [1, false],
    [99, false],
  ] as const)("evaluates prime(%i) as %s", (value, expected) => {
    expect(matchesPredicate(value, { kind: "prime" })).toBe(expected);
  });

  it("evaluates divisor, explicit-value, and inclusive-range predicates", () => {
    expect(matchesPredicate(12, { kind: "divisible_by", divisor: 3 })).toBe(true);
    expect(matchesPredicate(12, { kind: "one_of", values: [10, 12] })).toBe(true);
    expect(matchesPredicate(12, { kind: "range", minimum: 12, maximum: 20 })).toBe(true);
    expect(matchesPredicate(21, { kind: "range", minimum: 12, maximum: 20 })).toBe(false);
  });
});
