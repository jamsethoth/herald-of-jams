export function installControlChannel(
  input: NodeJS.ReadableStream,
  requestShutdown: () => Promise<void>,
): () => void {
  let buffer = "";
  let shutdownRequested = false;

  const onData = (chunk: string | Buffer): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (line === "shutdown" && !shutdownRequested) {
        shutdownRequested = true;
        void requestShutdown().catch(() => undefined);
      }
    }
  };

  input.on("data", onData);
  return () => input.removeListener("data", onData);
}
