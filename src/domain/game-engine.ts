import { penaltySeverity, type PenaltySeverity } from "./scoring.js";
import type { CompiledRound, NumericParseResult } from "./types.js";

export type RoundState =
  | "waiting_for_start"
  | "counting"
  | "paused"
  | "completed"
  | "cancelled";

export interface EngineState {
  roundState: RoundState;
  pausedFrom?: "waiting_for_start" | "counting";
  nextPosition: number;
  previousAcceptedPlayerId?: string;
  acceptedCount: number;
  bannedPlayerIds: ReadonlySet<string>;
}

export interface EngineInput {
  playerId: string;
  parsed: NumericParseResult;
  compiled: CompiledRound;
}

export type EngineDecision =
  | { kind: "conversation" }
  | { kind: "delete_without_effect"; reason: "waiting" | "paused" | "banned" }
  | {
      kind: "accepted";
      position: number;
      bonusRuleIds: readonly string[];
      completesRound: boolean;
    }
  | {
      kind: "broken";
      reason: "unexpected" | "same_player" | "out_of_range";
      severity: PenaltySeverity;
    };

export class DomainStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainStateError";
  }
}

function withoutPausedFrom(state: EngineState): EngineState {
  const { pausedFrom: _pausedFrom, ...rest } = state;
  return rest;
}

export function evaluateSubmission(state: EngineState, input: EngineInput): EngineDecision {
  if (state.roundState === "completed" || state.roundState === "cancelled") {
    throw new DomainStateError(`cannot evaluate a ${state.roundState} round`);
  }
  if (input.parsed.kind === "conversation") {
    return { kind: "conversation" };
  }
  if (state.roundState === "paused") {
    return { kind: "delete_without_effect", reason: "paused" };
  }
  if (state.bannedPlayerIds.has(input.playerId)) {
    return { kind: "delete_without_effect", reason: "banned" };
  }
  if (state.roundState === "waiting_for_start") {
    const startingEntry = input.compiled.entries[0];
    if (
      input.parsed.kind !== "safe_integer" ||
      startingEntry === undefined ||
      input.parsed.value !== startingEntry.value
    ) {
      return { kind: "delete_without_effect", reason: "waiting" };
    }
    return {
      kind: "accepted",
      position: startingEntry.position,
      bonusRuleIds: startingEntry.bonusRuleIds,
      completesRound: input.compiled.entries.length === 1,
    };
  }

  const expected = input.compiled.entries[state.nextPosition];
  if (expected === undefined) {
    throw new DomainStateError("counting state has no expected compiled entry");
  }
  const severity = () => penaltySeverity(state.acceptedCount, input.compiled.entries.length);
  if (input.parsed.kind === "out_of_range") {
    return { kind: "broken", reason: "out_of_range", severity: severity() };
  }
  if (state.previousAcceptedPlayerId === input.playerId) {
    return { kind: "broken", reason: "same_player", severity: severity() };
  }
  if (input.parsed.value !== expected.value) {
    return { kind: "broken", reason: "unexpected", severity: severity() };
  }
  return {
    kind: "accepted",
    position: expected.position,
    bonusRuleIds: expected.bonusRuleIds,
    completesRound: state.nextPosition === input.compiled.entries.length - 1,
  };
}

export function pauseRound(state: EngineState): EngineState {
  if (state.roundState !== "waiting_for_start" && state.roundState !== "counting") {
    throw new DomainStateError(`cannot pause a ${state.roundState} round`);
  }
  return { ...state, roundState: "paused", pausedFrom: state.roundState };
}

export function resumeRound(state: EngineState): EngineState {
  if (state.roundState !== "paused" || state.pausedFrom === undefined) {
    throw new DomainStateError(`cannot resume a ${state.roundState} round`);
  }
  return { ...withoutPausedFrom(state), roundState: state.pausedFrom };
}

export function cancelRound(state: EngineState): EngineState {
  if (state.roundState === "completed" || state.roundState === "cancelled") {
    throw new DomainStateError(`cannot cancel a ${state.roundState} round`);
  }
  return { ...withoutPausedFrom(state), roundState: "cancelled" };
}
