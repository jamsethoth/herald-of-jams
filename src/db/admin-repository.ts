import type Database from "better-sqlite3";

import type { Clock, IdGenerator } from "../application/contracts.js";
import { compileRound } from "../domain/round-compiler.js";
import type { RoundTemplateInput } from "../domain/types.js";

interface TemplateRow {
  private_name: string;
  notes: string | null;
  channel_id: string;
  start_value: number;
  target_value: number;
  step_value: number;
  rules_json: string;
}

export class AdminRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createTemplate(input: RoundTemplateInput): string {
    compileRound(input);
    const id = this.ids.next();
    const now = this.clock.now().toISOString();
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `INSERT INTO round_templates
              (id, private_name, notes, channel_id, start_value, target_value, step_value,
               rules_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        `SELECT private_name, notes, channel_id, start_value, target_value, step_value, rules_json
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
    return {
      name: row.private_name,
      ...(row.notes === null ? {} : { notes: row.notes }),
      channelId: row.channel_id,
      start: row.start_value,
      target: row.target_value,
      step: row.step_value,
      skipRules: rules.skipRules,
      bonusRules: rules.bonusRules,
    };
  }
}
