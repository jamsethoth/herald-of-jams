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
        start: "Begin with {start}",
        bonus: "Bonus: {player} +{bonusPoints}",
        reset: "",
      }),
    ).toMatchObject({
      start: "Begin with {start}",
      bonus: "Bonus: {player} +{bonusPoints}",
      reset: DEFAULT_ANNOUNCEMENTS.reset,
    });
  });

  it.each([
    ["start", "Bad {target}"],
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

  it("renders the optional start placeholder", () => {
    expect(renderAnnouncement("start", "Round open: start with {start}", { start: 7 })).toBe(
      "Round open: start with 7",
    );
    expect(renderAnnouncement("start", "A new round is open")).toBe(
      "A new round is open",
    );
  });
});
