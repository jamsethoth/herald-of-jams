import { describe, expect, it } from "vitest";

import {
  additionalPenalty,
  participationAwards,
  penaltySeverity,
} from "../src/domain/scoring.js";

describe("participationAwards", () => {
  it("uses exact comparisons immediately around every contribution boundary", () => {
    const awardFor = (count: number) =>
      participationAwards(
        new Map([
          ["subject", count],
          ["a", 100],
          ["b", 100],
          ["balancer", 200 - count],
        ]),
      ).get("subject");

    expect(awardFor(74)).toBe(2);
    expect(awardFor(75)).toBe(3);
    expect(awardFor(76)).toBe(3);
    expect(awardFor(109)).toBe(3);
    expect(awardFor(110)).toBe(4);
    expect(awardFor(111)).toBe(4);
    expect(awardFor(149)).toBe(4);
    expect(awardFor(150)).toBe(5);
    expect(awardFor(151)).toBe(5);
  });

  it("returns an empty map for no contributors and rejects invalid counts", () => {
    expect(participationAwards(new Map())).toEqual(new Map());
    expect(() => participationAwards(new Map([["zero", 0]]))).toThrow(/positive safe integer/i);
  });
});

describe("penaltySeverity", () => {
  it.each([
    [1, 4, -2],
    [2, 8, -2],
    [2, 7, -3],
    [1, 2, -3],
    [3, 6, -3],
    [4, 7, -4],
    [3, 4, -4],
    [4, 5, -5],
  ] as const)("maps %i/%i progress to %i", (accepted, required, expected) => {
    expect(penaltySeverity(accepted, required)).toBe(expected);
  });

  it("rejects impossible attempt progress", () => {
    expect(() => penaltySeverity(0, 10)).toThrow(/accepted/i);
    expect(() => penaltySeverity(11, 10)).toThrow(/accepted/i);
  });
});

describe("additionalPenalty", () => {
  it("charges only a worsening delta against the round cap", () => {
    expect(additionalPenalty(0, -2)).toBe(-2);
    expect(additionalPenalty(-2, -5)).toBe(-3);
    expect(additionalPenalty(-5, -3)).toBe(0);
    expect(additionalPenalty(-3, -3)).toBe(0);
  });
});
