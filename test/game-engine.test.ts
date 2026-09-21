import { describe, expect, it } from "vitest";

import {
  cancelRound,
  DomainStateError,
  evaluateSubmission,
  pauseRound,
  resumeRound,
  type EngineState,
} from "../src/domain/game-engine.js";
import { compileRound } from "../src/domain/round-compiler.js";

const compiled = compileRound({
  name: "Count",
  channelId: "123",
  start: 1,
  target: 5,
  step: 1,
  skipRules: [{ kind: "one_of", values: [3] }],
  bonusRules: [
    { id: "even", predicate: { kind: "divisible_by", divisor: 2 } },
    { id: "finish", predicate: { kind: "range", minimum: 4, maximum: 5 } },
  ],
});

function state(overrides: Partial<EngineState> = {}): EngineState {
  return {
    roundState: "waiting_for_start",
    nextPosition: 0,
    acceptedCount: 0,
    bannedPlayerIds: new Set(),
    ...overrides,
  };
}

describe("evaluateSubmission", () => {
  it("accepts and canonicalizes the starting value", () => {
    expect(
      evaluateSubmission(state(), {
        playerId: "alice",
        parsed: { kind: "safe_integer", digits: "01", value: 1 },
        compiled,
      }),
    ).toEqual({ kind: "accepted", position: 0, bonusRuleIds: [], completesRound: false });
  });

  it("deletes a wrong or out-of-range number harmlessly while waiting", () => {
    expect(
      evaluateSubmission(state(), {
        playerId: "alice",
        parsed: { kind: "safe_integer", digits: "2", value: 2 },
        compiled,
      }),
    ).toEqual({ kind: "delete_without_effect", reason: "waiting" });
    expect(
      evaluateSubmission(state(), {
        playerId: "alice",
        parsed: { kind: "out_of_range", digits: "9".repeat(20) },
        compiled,
      }),
    ).toEqual({ kind: "delete_without_effect", reason: "waiting" });
  });

  it("accepts the expected value and returns stacked bonus IDs", () => {
    expect(
      evaluateSubmission(
        state({
          roundState: "counting",
          nextPosition: 2,
          previousAcceptedPlayerId: "alice",
          acceptedCount: 2,
        }),
        {
          playerId: "bob",
          parsed: { kind: "safe_integer", digits: "4", value: 4 },
          compiled,
        },
      ),
    ).toEqual({
      kind: "accepted",
      position: 2,
      bonusRuleIds: ["even", "finish"],
      completesRound: false,
    });
  });

  it("preserves the consecutive-player check across ordinary conversation", () => {
    const active = state({
      roundState: "counting",
      nextPosition: 1,
      previousAcceptedPlayerId: "alice",
      acceptedCount: 1,
    });
    expect(
      evaluateSubmission(active, {
        playerId: "someone",
        parsed: { kind: "conversation" },
        compiled,
      }),
    ).toEqual({ kind: "conversation" });
    expect(
      evaluateSubmission(active, {
        playerId: "alice",
        parsed: { kind: "safe_integer", digits: "2", value: 2 },
        compiled,
      }),
    ).toEqual({ kind: "broken", reason: "same_player", severity: -2 });
  });

  it.each([
    [{ kind: "safe_integer", digits: "1", value: 1 } as const, "unexpected"],
    [{ kind: "safe_integer", digits: "3", value: 3 } as const, "unexpected"],
    [{ kind: "safe_integer", digits: "5", value: 5 } as const, "unexpected"],
    [{ kind: "out_of_range", digits: "9".repeat(20) } as const, "out_of_range"],
  ] as const)("breaks an active attempt for %j", (parsed, reason) => {
    expect(
      evaluateSubmission(
        state({
          roundState: "counting",
          nextPosition: 1,
          previousAcceptedPlayerId: "alice",
          acceptedCount: 1,
        }),
        { playerId: "bob", parsed, compiled },
      ),
    ).toEqual({ kind: "broken", reason, severity: -2 });
  });

  it("ignores banned numeric submissions and preserves conversation", () => {
    const banned = state({
      roundState: "counting",
      nextPosition: 1,
      acceptedCount: 1,
      bannedPlayerIds: new Set(["alice"]),
    });
    expect(
      evaluateSubmission(banned, {
        playerId: "alice",
        parsed: { kind: "safe_integer", digits: "2", value: 2 },
        compiled,
      }),
    ).toEqual({ kind: "delete_without_effect", reason: "banned" });
    expect(
      evaluateSubmission(banned, {
        playerId: "alice",
        parsed: { kind: "conversation" },
        compiled,
      }),
    ).toEqual({ kind: "conversation" });
  });

  it("deletes numeric submissions without evaluation while paused", () => {
    expect(
      evaluateSubmission(
        state({ roundState: "paused", pausedFrom: "counting", nextPosition: 1 }),
        {
          playerId: "alice",
          parsed: { kind: "safe_integer", digits: "2", value: 2 },
          compiled,
        },
      ),
    ).toEqual({ kind: "delete_without_effect", reason: "paused" });
  });

  it("marks target acceptance as completion", () => {
    expect(
      evaluateSubmission(
        state({
          roundState: "counting",
          nextPosition: 3,
          previousAcceptedPlayerId: "alice",
          acceptedCount: 3,
        }),
        {
          playerId: "bob",
          parsed: { kind: "safe_integer", digits: "5", value: 5 },
          compiled,
        },
      ),
    ).toEqual({
      kind: "accepted",
      position: 3,
      bonusRuleIds: ["finish"],
      completesRound: true,
    });
  });
});

describe("administrative transitions", () => {
  it("pauses and resumes waiting and counting states without mutation", () => {
    const active = state({
      roundState: "counting",
      nextPosition: 2,
      previousAcceptedPlayerId: "alice",
      acceptedCount: 2,
    });
    const paused = pauseRound(active);

    expect(paused).toEqual({ ...active, roundState: "paused", pausedFrom: "counting" });
    expect(resumeRound(paused)).toEqual(active);
    expect(active.roundState).toBe("counting");
  });

  it("cancels active or paused rounds as a terminal transition", () => {
    const cancelled = cancelRound(
      state({ roundState: "paused", pausedFrom: "waiting_for_start" }),
    );

    expect(cancelled.roundState).toBe("cancelled");
    expect(cancelled).not.toHaveProperty("pausedFrom");
    expect(() => resumeRound(cancelled)).toThrow(DomainStateError);
    expect(() => pauseRound(cancelled)).toThrow(DomainStateError);
    expect(() => cancelRound(cancelled)).toThrow(DomainStateError);
  });

  it("rejects evaluation after a terminal transition", () => {
    expect(() =>
      evaluateSubmission(state({ roundState: "completed" }), {
        playerId: "alice",
        parsed: { kind: "conversation" },
        compiled,
      }),
    ).toThrow(DomainStateError);
  });
});
