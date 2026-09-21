import type Database from "better-sqlite3";

import type { Clock, IdGenerator } from "../application/contracts.js";
import { resolveAnnouncements } from "../domain/announcement-templates.js";
import { compileRound } from "../domain/round-compiler.js";
import type {
  AnnouncementOverrides,
  AnnouncementTemplates,
  RoundTemplateInput,
} from "../domain/types.js";

interface TemplateRow {
  private_name: string;
  notes: string | null;
  channel_id: string;
  start_value: number;
  target_value: number;
  step_value: number;
  rules_json: string;
  bonus_announcement_override: string | null;
  reset_announcement_override: string | null;
  completion_announcement_override: string | null;
  cancellation_announcement_override: string | null;
}

interface AnnouncementSettingsRow {
  bonus_announcement: string;
  reset_announcement: string;
  completion_announcement: string;
  cancellation_announcement: string;
}

const ANNOUNCEMENT_KINDS = ["bonus", "reset", "completion", "cancellation"] as const;

function normalizeOverrides(overrides: AnnouncementOverrides | undefined): AnnouncementOverrides {
  if (overrides === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value.length > 0),
  ) as AnnouncementOverrides;
}

export interface TemplateSummary {
  id: string;
  name: string;
  channelId: string;
  updatedAt: string;
}

export class AdminRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createTemplate(input: RoundTemplateInput): string {
    const announcements = normalizeOverrides(input.announcements);
    compileRound(
      {
        ...input,
        ...(Object.keys(announcements).length === 0 ? {} : { announcements }),
      },
      this.getAnnouncementDefaults(),
    );
    const id = this.ids.next();
    const now = this.clock.now().toISOString();
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `INSERT INTO round_templates
              (id, private_name, notes, channel_id, start_value, target_value, step_value,
               rules_json, bonus_announcement_override, reset_announcement_override,
               completion_announcement_override, cancellation_announcement_override,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.name,
            input.notes ?? null,
            input.channelId,
            input.start,
            input.target,
            input.step,
            JSON.stringify({ skipRules: input.skipRules, bonusRules: input.bonusRules }),
            announcements.bonus ?? null,
            announcements.reset ?? null,
            announcements.completion ?? null,
            announcements.cancellation ?? null,
            now,
            now,
          );
      })
      .immediate();
    return id;
  }

  getTemplate(id: string): RoundTemplateInput {
    const row = this.database
      .prepare(
        `SELECT private_name, notes, channel_id, start_value, target_value, step_value, rules_json,
                bonus_announcement_override, reset_announcement_override,
                completion_announcement_override, cancellation_announcement_override
         FROM round_templates WHERE id = ?`,
      )
      .get(id) as TemplateRow | undefined;
    if (row === undefined) {
      throw new Error(`round template not found: ${id}`);
    }
    const rules = JSON.parse(row.rules_json) as Pick<
      RoundTemplateInput,
      "skipRules" | "bonusRules"
    >;
    const announcements: AnnouncementOverrides = {
      ...(row.bonus_announcement_override === null
        ? {}
        : { bonus: row.bonus_announcement_override }),
      ...(row.reset_announcement_override === null
        ? {}
        : { reset: row.reset_announcement_override }),
      ...(row.completion_announcement_override === null
        ? {}
        : { completion: row.completion_announcement_override }),
      ...(row.cancellation_announcement_override === null
        ? {}
        : { cancellation: row.cancellation_announcement_override }),
    };
    return {
      name: row.private_name,
      ...(row.notes === null ? {} : { notes: row.notes }),
      channelId: row.channel_id,
      start: row.start_value,
      target: row.target_value,
      step: row.step_value,
      skipRules: rules.skipRules,
      bonusRules: rules.bonusRules,
      ...(Object.keys(announcements).length === 0 ? {} : { announcements }),
    };
  }

  listTemplates(): readonly TemplateSummary[] {
    return this.database
      .prepare(
        `SELECT id, private_name AS name, channel_id AS channelId, updated_at AS updatedAt
         FROM round_templates ORDER BY private_name COLLATE NOCASE, id`,
      )
      .all() as TemplateSummary[];
  }

  updateTemplate(id: string, input: RoundTemplateInput): void {
    const announcements = normalizeOverrides(input.announcements);
    compileRound(
      {
        ...input,
        ...(Object.keys(announcements).length === 0 ? {} : { announcements }),
      },
      this.getAnnouncementDefaults(),
    );
    const result = this.database
      .prepare(
        `UPDATE round_templates SET
           private_name = ?, notes = ?, channel_id = ?, start_value = ?, target_value = ?,
           step_value = ?, rules_json = ?, bonus_announcement_override = ?,
           reset_announcement_override = ?, completion_announcement_override = ?,
           cancellation_announcement_override = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.notes ?? null,
        input.channelId,
        input.start,
        input.target,
        input.step,
        JSON.stringify({ skipRules: input.skipRules, bonusRules: input.bonusRules }),
        announcements.bonus ?? null,
        announcements.reset ?? null,
        announcements.completion ?? null,
        announcements.cancellation ?? null,
        this.clock.now().toISOString(),
        id,
      );
    if (result.changes !== 1) {
      throw new Error(`round template not found: ${id}`);
    }
  }

  getAnnouncementDefaults(): AnnouncementTemplates {
    const row = this.database
      .prepare(
        `SELECT bonus_announcement, reset_announcement, completion_announcement,
                cancellation_announcement
         FROM announcement_settings WHERE id = 1`,
      )
      .get() as AnnouncementSettingsRow | undefined;
    if (row === undefined) {
      throw new Error("announcement settings not found");
    }
    return {
      bonus: row.bonus_announcement,
      reset: row.reset_announcement,
      completion: row.completion_announcement,
      cancellation: row.cancellation_announcement,
    };
  }

  updateAnnouncementDefaults(input: AnnouncementTemplates, actorId: string): void {
    const validated = resolveAnnouncements(input, {});
    const current = this.getAnnouncementDefaults();
    const fields = ANNOUNCEMENT_KINDS.filter((kind) => current[kind] !== validated[kind]);
    const now = this.clock.now().toISOString();
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `UPDATE announcement_settings SET
               bonus_announcement = ?, reset_announcement = ?, completion_announcement = ?,
               cancellation_announcement = ?, updated_at = ?
             WHERE id = 1`,
          )
          .run(
            validated.bonus,
            validated.reset,
            validated.completion,
            validated.cancellation,
            now,
          );
        this.database
          .prepare(
            `INSERT INTO audit_events
              (id, event_type, actor_id, details_json, created_at)
             VALUES (?, 'announcement_defaults_updated', ?, ?, ?)`,
          )
          .run(this.ids.next(), actorId, JSON.stringify({ fields }), now);
      })
      .immediate();
  }
}
