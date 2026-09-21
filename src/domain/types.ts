export type NumericParseResult =
  | { kind: "conversation" }
  | { kind: "safe_integer"; digits: string; value: number }
  | { kind: "out_of_range"; digits: string };

export type RulePredicate =
  | { kind: "prime" }
  | { kind: "divisible_by"; divisor: number }
  | { kind: "one_of"; values: readonly number[] }
  | { kind: "range"; minimum: number; maximum: number };

export interface BonusRule {
  id: string;
  predicate: RulePredicate;
}

export type AnnouncementKind = "start" | "bonus" | "reset" | "completion" | "cancellation";

export interface AnnouncementTemplates {
  start: string;
  bonus: string;
  reset: string;
  completion: string;
  cancellation: string;
}

export type AnnouncementOverrides = Partial<AnnouncementTemplates>;

export interface RoundTemplateInput {
  name: string;
  notes?: string;
  channelId: string;
  start: number;
  target: number;
  step: number;
  skipRules: readonly RulePredicate[];
  bonusRules: readonly BonusRule[];
  announcements?: AnnouncementOverrides;
}

export interface CompiledEntry {
  position: number;
  value: number;
  bonusRuleIds: readonly string[];
}

export interface CompiledRound {
  input: Readonly<RoundTemplateInput>;
  entries: readonly CompiledEntry[];
  announcements: Readonly<AnnouncementTemplates>;
}
