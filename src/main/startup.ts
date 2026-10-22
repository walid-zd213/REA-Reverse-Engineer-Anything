import type { BinarySession } from "../application/binary/BinarySession.js";
import type { AppConfig } from "../config/types.js";
import type { Logger } from "pino";
import {
  isCancelledAnalysisError,
  projectAnalysisError,
} from "../domain/analysisErrorProjection.js";

export const openInitialTarget = async (
  session: BinarySession,
  config: AppConfig,
  {
    serverLogger,
    writeStderr,
    signal,
  }: {
    readonly serverLogger: Logger;
    readonly writeStderr: (text: string) => void;
    readonly signal: AbortSignal;
  },
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly exitCode: 1;
      /** The session retained cleanup ownership after close failed. */
      readonly cleanupPending: boolean;
    }
  | { readonly ok: false; readonly cancelled: true }
> => {
  if (config.hopperTargetPath === undefined) return { ok: true };
  const opened = await session.open(config.hopperTargetPath, {
    targetKind: config.hopperTargetKind,
    signal,
    // The abort is a process shutdown, which keeps provider documents open.
    retainProviderDocumentsOnCancel: true,
  });
  if (opened.ok) return { ok: true };
  // The shutdown that aborted the open owns session cleanup and its outcome.
  // A failure that preceded the request remains the startup failure.
  if (signal.aborted && isCancelledAnalysisError(opened.error))
    return { ok: false, cancelled: true };
  const closed = await session.close();
  serverLogger.error(
    {
      error: projectAnalysisError(opened.error),
      ...(closed.ok
        ? {}
        : { cleanup_error: projectAnalysisError(closed.error) }),
    },
    "Initial target failed to open",
  );
  writeStderr(`${projectAnalysisError(opened.error).message}\n`);
  if (!closed.ok)
    writeStderr(`${projectAnalysisError(closed.error).message}\n`);
  return { ok: false, exitCode: 1, cleanupPending: !closed.ok };
};
