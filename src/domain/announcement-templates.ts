import type {
  AnnouncementKind,
  AnnouncementOverrides,
  AnnouncementTemplates,
} from "./types.js";

export const MAX_ANNOUNCEMENT_TEMPLATE_LENGTH = 1_900;
export const MAX_DISCORD_MESSAGE_LENGTH = 2_000;

export const DEFAULT_ANNOUNCEMENTS: Readonly<AnnouncementTemplates> = Object.freeze({
  bonus: "{player} earned {bonusPoints} provisional bonus points.",
  reset:
    "The attempt was reset. Provisional rewards were discarded; penalties remain. Start again at {start}.",
  completion: "The round is complete. Final rewards have been recorded.",
  cancellation:
    "The round was cancelled. All provisional rewards and round penalties were discarded.",
});

const KINDS = ["bonus", "reset", "completion", "cancellation"] as const;
const ALLOWED_PLACEHOLDERS: Readonly<Record<AnnouncementKind, ReadonlySet<string>>> = {
  bonus: new Set(["player", "bonusPoints"]),
  reset: new Set(["start"]),
  completion: new Set(),
  cancellation: new Set(),
};

export interface AnnouncementValues {
  player?: string;
  bonusPoints?: number;
  start?: number;
}

function validateTemplate(kind: AnnouncementKind, template: string): void {
  if (template.length === 0) {
    throw new TypeError(`${kind} announcement must not be empty`);
  }
  if (template.length > MAX_ANNOUNCEMENT_TEMPLATE_LENGTH) {
    throw new RangeError(
      `${kind} announcement cannot exceed ${MAX_ANNOUNCEMENT_TEMPLATE_LENGTH} characters`,
    );
  }

  const withoutTokens = template.replace(/\{([^{}]*)\}/g, (_match, placeholder: string) => {
    if (placeholder.length === 0 || !ALLOWED_PLACEHOLDERS[kind].has(placeholder)) {
      throw new TypeError(`invalid placeholder {${placeholder}} in ${kind} announcement`);
    }
    return "";
  });
  if (/[{}]/.test(withoutTokens)) {
    throw new TypeError(`unmatched brace in ${kind} announcement`);
  }
}

export function resolveAnnouncements(
  defaults: AnnouncementTemplates,
  overrides: AnnouncementOverrides = {},
): Readonly<AnnouncementTemplates> {
  const resolved = {} as AnnouncementTemplates;
  for (const kind of KINDS) {
    validateTemplate(kind, defaults[kind]);
    const override = overrides[kind];
    const value = override === undefined || override.length === 0 ? defaults[kind] : override;
    validateTemplate(kind, value);
    resolved[kind] = value;
  }
  return Object.freeze(resolved);
}

export function renderAnnouncement(
  kind: AnnouncementKind,
  template: string,
  values: AnnouncementValues = {},
): string {
  validateTemplate(kind, template);
  const rendered = template.replace(/\{([^{}]+)\}/g, (_match, placeholder: string) => {
    const value = values[placeholder as keyof AnnouncementValues];
    if (value === undefined) {
      throw new TypeError(`missing value for placeholder {${placeholder}}`);
    }
    return String(value);
  });
  if (rendered.length > MAX_DISCORD_MESSAGE_LENGTH) {
    throw new RangeError(
      `${kind} announcement cannot exceed ${MAX_DISCORD_MESSAGE_LENGTH} rendered characters`,
    );
  }
  return rendered;
}
