import { describe, expect, it } from "vitest";

import {
  REQUIRED_CAPABILITIES,
  validateActivationPermissions,
  type ActivationCapabilities,
} from "../src/discord/permissions.js";

const allCapabilities: ActivationCapabilities = {
  viewChannel: true,
  readMessageHistory: true,
  sendMessages: true,
  manageMessages: true,
  useApplicationCommands: true,
  messageContentIntent: true,
};

describe("validateActivationPermissions", () => {
  it("accepts the complete required capability set", () => {
    expect(validateActivationPermissions(allCapabilities)).toEqual({ ok: true, missing: [] });
  });

  it.each(REQUIRED_CAPABILITIES)("reports missing %s specifically", (capability) => {
    const report = validateActivationPermissions({ ...allCapabilities, [capability]: false });

    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([capability]);
  });
});
