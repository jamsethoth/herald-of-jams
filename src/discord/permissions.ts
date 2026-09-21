export const REQUIRED_CAPABILITIES = [
  "viewChannel",
  "readMessageHistory",
  "sendMessages",
  "manageMessages",
  "useApplicationCommands",
  "messageContentIntent",
] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];

export type ActivationCapabilities = Record<RequiredCapability, boolean>;

export interface PermissionReport {
  ok: boolean;
  missing: readonly RequiredCapability[];
}

export function validateActivationPermissions(
  capabilities: ActivationCapabilities,
): PermissionReport {
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities[capability]);
  return { ok: missing.length === 0, missing };
}
