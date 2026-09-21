import { describe, expect, it } from "vitest";

import { compileRound } from "../src/domain/round-compiler.js";
import type { RoundTemplateInput } from "../src/domain/types.js";

function template(overrides: Partial<RoundTemplateInput> = {}): RoundTemplateInput {
  return {
    name: "Odd numbers",
    notes: "A test round",
    channelId: "123",
    start: 1,
    target: 9,
    step: 2,
    skipRules: [],
    bonusRules: [],
    ...overrides,
  };
}

describe("compileRound", () => {
  it("compiles the reachable arithmetic sequence", () => {
    expect(compileRound(template()).entries.map((entry) => entry.value)).toEqual([
      1, 3, 5, 7, 9,
    ]);
  });

  it("combines skip rules with OR and stacks independently matching bonuses", () => {
    const compiled = compileRound(
      template({
        start: 1,
        target: 15,
        step: 1,
        skipRules: [
          { kind: "prime" },
          { kind: "one_of", values: [8, 12] },
        ],
        bonusRules: [
          { id: "even", predicate: { kind: "divisible_by", divisor: 2 } },
          { id: "upper", predicate: { kind: "range", minimum: 9, maximum: 15 } },
        ],
      }),
    );

    expect(compiled.entries.map((entry) => entry.value)).toEqual([1, 4, 6, 9, 10, 14, 15]);
    expect(compiled.entries.find((entry) => entry.value === 10)?.bonusRuleIds).toEqual([
      "even",
      "upper",
    ]);
  });

  it("always includes the start even when a skip rule matches it", () => {
    const compiled = compileRound(
      template({ start: 2, target: 8, step: 2, skipRules: [{ kind: "prime" }] }),
    );

    expect(compiled.entries.map((entry) => entry.value)).toEqual([2, 4, 6, 8]);
  });

  it("rejects a target removed by a skip rule", () => {
    expect(() =>
      compileRound(
        template({
          target: 10,
          step: 1,
          skipRules: [{ kind: "divisible_by", divisor: 5 }],
        }),
      ),
    ).toThrow(/target.*skipped/i);
  });

  it("rejects a target that cannot be reached by the step", () => {
    expect(() => compileRound(template({ start: 1, target: 10, step: 2 }))).toThrow(
      /target.*reachable/i,
    );
  });

  it("compiles equal start and target as one immutable entry", () => {
    const compiled = compileRound(
      template({
        start: 2,
        target: 2,
        step: 1,
        skipRules: [{ kind: "prime" }],
        announcements: { completion: "Done" },
      }),
    );

    expect(compiled.entries.map(({ value }) => value)).toEqual([2]);
    expect(compiled.announcements.completion).toBe("Done");
    expect(Object.isFrozen(compiled.announcements)).toBe(true);
  });

  it.each([
    ["unsafe start", { start: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative start", { start: -1 }],
    ["unsafe target", { target: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative target", { target: -1 }],
    ["reversed bounds", { start: 2, target: 1 }],
    ["zero step", { step: 0 }],
    ["negative step", { step: -1 }],
    ["unsafe step", { step: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)("rejects %s", (_name, overrides) => {
    expect(() => compileRound(template(overrides))).toThrow();
  });

  it.each([
    { kind: "divisible_by", divisor: 0 } as const,
    { kind: "divisible_by", divisor: 1.5 } as const,
    { kind: "one_of", values: [-1] } as const,
    { kind: "one_of", values: [Number.MAX_SAFE_INTEGER + 1] } as const,
    { kind: "range", minimum: 10, maximum: 9 } as const,
    { kind: "range", minimum: -1, maximum: 9 } as const,
    { kind: "range", minimum: 0, maximum: Number.MAX_SAFE_INTEGER + 1 } as const,
  ])("rejects invalid predicate $kind", (predicate) => {
    expect(() => compileRound(template({ skipRules: [predicate] }))).toThrow(/predicate/i);
  });

  it("rejects duplicate and empty bonus IDs", () => {
    const predicate = { kind: "prime" } as const;

    expect(() =>
      compileRound(
        template({
          bonusRules: [
            { id: "prime", predicate },
            { id: "prime", predicate },
          ],
        }),
      ),
    ).toThrow(/duplicate bonus/i);
    expect(() =>
      compileRound(template({ bonusRules: [{ id: "", predicate }] })),
    ).toThrow(/bonus.*id/i);
  });

  it("rejects more than 100,000 included entries", () => {
    expect(() =>
      compileRound(template({ start: 0, target: 100_000, step: 1 })),
    ).toThrow(/100,000 included/i);
  });

  it("rejects more than 1,000,000 candidate entries before iteration", () => {
    expect(() =>
      compileRound(template({ start: 0, target: 1_000_000, step: 1 })),
    ).toThrow(/1,000,000 candidate/i);
  });

  it("copies and deeply freezes its input and entries", () => {
    const skipValues = [4];
    const bonusValues = [5];
    const input = template({
      start: 1,
      target: 5,
      step: 1,
      skipRules: [{ kind: "one_of", values: skipValues }],
      bonusRules: [{ id: "five", predicate: { kind: "one_of", values: bonusValues } }],
    });
    const compiled = compileRound(input);

    skipValues.push(3);
    bonusValues.push(3);
    input.skipRules = [];
    input.bonusRules = [];

    expect(compiled.entries.map((entry) => entry.value)).toEqual([1, 2, 3, 5]);
    expect(compiled.entries.at(-1)?.bonusRuleIds).toEqual(["five"]);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.input)).toBe(true);
    expect(Object.isFrozen(compiled.input.skipRules)).toBe(true);
    expect(Object.isFrozen(compiled.entries)).toBe(true);
    expect(Object.isFrozen(compiled.entries[0])).toBe(true);
  });
});
