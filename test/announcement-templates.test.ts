import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANNOUNCEMENTS,
  renderAnnouncement,
  resolveAnnouncements,
} from "../src/domain/announcement-templates.js";

describe("announcement templates", () => {
  it("inherits blanks and applies typed overrides", () => {
    expect(
      resolveAnnouncements(DEFAULT_ANNOUNCEMENTS, {
        bonus: "Bonus: {player} +{bonusPoints}",
        reset: "",
      }),
    ).toMatchObject({
      bonus: "Bonus: {player} +{bonusPoints}",
      reset: DEFAULT_ANNOUNCEMENTS.reset,
    });
  });

  it.each([
    ["bonus", "Bad {start}"],
    ["reset", "Bad {player}"],
    ["completion", "Bad {player}"],
    ["cancellation", "Bad {unknown}"],
    ["bonus", "Bad {player"],
  ] as const)("rejects invalid %s placeholders", (kind, value) => {
    expect(() =>
      resolveAnnouncements(DEFAULT_ANNOUNCEMENTS, { [kind]: value }),
    ).toThrow(/placeholder|brace/i);
  });

  it("renders allowed placeholders within Discord's limit", () => {
    const rendered = renderAnnouncement(
      "bonus",
      `${"x".repeat(1_850)} {player} {bonusPoints}`,
      { player: "p".repeat(32), bonusPoints: 100_000 },
    );

    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });
});
