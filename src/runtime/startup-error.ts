interface ErrorWithCode {
  readonly code?: unknown;
}

export function formatStartupError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("Invalid configuration")) {
    return error.message;
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = (error as ErrorWithCode | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? `Herald of Jams failed to start: ${name} [${code}]`
    : `Herald of Jams failed to start: ${name}`;
}
