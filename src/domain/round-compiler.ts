import { matchesPredicate } from "./predicates.js";
import {
  DEFAULT_ANNOUNCEMENTS,
  resolveAnnouncements,
} from "./announcement-templates.js";
import type {
  AnnouncementTemplates,
  BonusRule,
  CompiledEntry,
  CompiledRound,
  RoundTemplateInput,
  RulePredicate,
} from "./types.js";

const MAX_INCLUDED_ENTRIES = 100_000;
const MAX_CANDIDATE_ENTRIES = 1_000_000;

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function copyPredicate(predicate: RulePredicate): RulePredicate {
  switch (predicate.kind) {
    case "prime":
      return Object.freeze({ kind: "prime" });
    case "divisible_by":
      if (!Number.isSafeInteger(predicate.divisor) || predicate.divisor <= 0) {
        throw new RangeError("divisible_by predicate divisor must be a positive safe integer");
      }
      return Object.freeze({ kind: "divisible_by", divisor: predicate.divisor });
    case "one_of": {
      if (!Array.isArray(predicate.values)) {
        throw new TypeError("one_of predicate values must be an array");
      }
      for (const value of predicate.values) {
        assertNonNegativeSafeInteger(value, "one_of predicate value");
      }
      return Object.freeze({
        kind: "one_of",
        values: Object.freeze([...predicate.values]),
      });
    }
    case "range":
      assertNonNegativeSafeInteger(predicate.minimum, "range predicate minimum");
      assertNonNegativeSafeInteger(predicate.maximum, "range predicate maximum");
      if (predicate.minimum > predicate.maximum) {
        throw new RangeError("range predicate minimum cannot exceed its maximum");
      }
      return Object.freeze({
        kind: "range",
        minimum: predicate.minimum,
        maximum: predicate.maximum,
      });
  }
}

function copyBonusRules(rules: readonly BonusRule[]): readonly BonusRule[] {
  const ids = new Set<string>();
  return Object.freeze(
    rules.map((rule) => {
      if (rule.id.length === 0) {
        throw new TypeError("bonus rule id must not be empty");
      }
      if (ids.has(rule.id)) {
        throw new TypeError(`duplicate bonus rule id: ${rule.id}`);
      }
      ids.add(rule.id);
      return Object.freeze({ id: rule.id, predicate: copyPredicate(rule.predicate) });
    }),
  );
}

function copyInput(input: RoundTemplateInput): Readonly<RoundTemplateInput> {
  const copied = {
    name: input.name,
    channelId: input.channelId,
    start: input.start,
    target: input.target,
    step: input.step,
    skipRules: Object.freeze(input.skipRules.map(copyPredicate)),
    bonusRules: copyBonusRules(input.bonusRules),
    ...(input.announcements === undefined
      ? {}
      : { announcements: Object.freeze({ ...input.announcements }) }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
  return Object.freeze(copied);
}

export function compileRound(
  input: RoundTemplateInput,
  defaults: AnnouncementTemplates = DEFAULT_ANNOUNCEMENTS,
): CompiledRound {
  assertNonNegativeSafeInteger(input.start, "start");
  assertNonNegativeSafeInteger(input.target, "target");
  if (!Number.isSafeInteger(input.step) || input.step <= 0) {
    throw new RangeError("step must be a positive safe integer");
  }
  if (input.target < input.start) {
    throw new RangeError("target must be greater than or equal to start");
  }

  const distance = input.target - input.start;
  if (distance % input.step !== 0) {
    throw new RangeError("target must be reachable from start using the configured step");
  }

  const candidateCount = distance / input.step + 1;
  if (candidateCount > MAX_CANDIDATE_ENTRIES) {
    throw new RangeError("round cannot exceed 1,000,000 candidate entries");
  }

  const copiedInput = copyInput(input);
  if (
    copiedInput.target !== copiedInput.start &&
    copiedInput.skipRules.some((rule) => matchesPredicate(copiedInput.target, rule))
  ) {
    throw new RangeError("target cannot be skipped by a skip rule");
  }

  const entries: CompiledEntry[] = [];
  for (let index = 0; index < candidateCount; index += 1) {
    const value = copiedInput.start + index * copiedInput.step;
    const skipped =
      index > 0 && copiedInput.skipRules.some((rule) => matchesPredicate(value, rule));
    if (skipped) {
      continue;
    }

    if (entries.length === MAX_INCLUDED_ENTRIES) {
      throw new RangeError("round cannot exceed 100,000 included entries");
    }
    const bonusRuleIds = Object.freeze(
      copiedInput.bonusRules
        .filter((rule) => matchesPredicate(value, rule.predicate))
        .map((rule) => rule.id),
    );
    entries.push(Object.freeze({ position: entries.length, value, bonusRuleIds }));
  }

  return Object.freeze({
    input: copiedInput,
    entries: Object.freeze(entries),
    announcements: resolveAnnouncements(defaults, copiedInput.announcements),
  });
}
