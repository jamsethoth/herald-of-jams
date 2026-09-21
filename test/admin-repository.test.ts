import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ANNOUNCEMENTS } from "../src/domain/announcement-templates.js";
import {
  createTestDatabase,
  roundTemplate,
  type TestDatabaseContext,
} from "./fixtures.js";

describe("AdminRepository announcement settings", () => {
  let context: TestDatabaseContext;

  beforeEach(() => {
    context = createTestDatabase();
  });

  afterEach(() => {
    context.close();
  });

  it("round-trips only the configured template overrides", () => {
    const id = context.adminRepository.createTemplate(
      roundTemplate({
        announcements: {
          start: "Begin with {start}",
          completion: "Template complete",
        },
      }),
    );

    expect(context.adminRepository.getTemplate(id).announcements).toEqual({
      start: "Begin with {start}",
      completion: "Template complete",
    });
    expect(context.adminRepository.getAnnouncementDefaults()).toEqual(DEFAULT_ANNOUNCEMENTS);
  });

  it("updates validated global defaults and audits field names without message bodies", () => {
    const updated = {
      ...DEFAULT_ANNOUNCEMENTS,
      bonus: "Bonus {player}: {bonusPoints}",
      completion: "A private custom completion message",
    };

    context.adminRepository.updateAnnouncementDefaults(updated, "admin");

    expect(context.adminRepository.getAnnouncementDefaults()).toEqual(updated);
    const audit = context.database
      .prepare(
        `SELECT actor_id, details_json FROM audit_events
         WHERE event_type = 'announcement_defaults_updated'`,
      )
      .get() as { actor_id: string; details_json: string };
    expect(audit.actor_id).toBe("admin");
    expect(JSON.parse(audit.details_json)).toEqual({ fields: ["bonus", "completion"] });
    expect(audit.details_json).not.toContain(updated.bonus);
    expect(audit.details_json).not.toContain(updated.completion);
  });
});
