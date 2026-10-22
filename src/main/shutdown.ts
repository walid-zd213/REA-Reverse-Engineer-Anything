import type { BinarySession } from "../application/binary/BinarySession.js";
import type { Logger } from "pino";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { McpServerHandle, RuntimeDependencies } from "./types.js";
import { MCP_SHUTDOWN_FAILED } from "./messages.js";

interface ShutdownCleanupOwner {
  readonly close: () => Promise<void>;
  closed: boolean;
  attempted: boolean;
  /** Left out of shutdown attempts while its operation is in progress. */
  deferred: boolean;
  /** Advanced on re-arm, so a close that began earlier cannot mark it closed. */
  generation: number;
}

/**
 * Resources transport startup adds to process shutdown. The handle is absent
 * when a shutdown request stopped startup before the transport started.
 */
export interface McpTransportOwners {
  readonly handle?: McpServerHandle;
  readonly closeAndroid?: () => Promise<void>;
  readonly closeOptionalProviders?: () => Promise<void>;
}

/**
 * Own process shutdown from session creation onward. A shutdown request aborts
 * `signal` so startup work stops, then closes every owner attached so far.
 * Owners attached after a request are closed by `finish`. Process handlers stay
 * registered until startup settles, so a repeated request during late cleanup
 * joins or retries it instead of reaching default signal termination.
 */
export const createShutdown = (input: {
  readonly session: BinarySession;
  readonly dependencies: RuntimeDependencies;
  readonly serverLogger: Logger;
}): {
  readonly signal: AbortSignal;
  readonly attachTransport: (owners: McpTransportOwners) => void;
  readonly shutdown: () => Promise<void>;
  readonly request: () => void;
  readonly whileOpening: <T>(open: () => Promise<T>) => Promise<T>;
  readonly finish: () => Promise<0 | 1>;
  readonly finishFailedOpen: () => Promise<0 | 1>;
  readonly release: () => Promise<void>;
} => {
  const { session, dependencies, serverLogger } = input;
  const requested = new AbortController();
  let shutdownAttempt: Promise<void> | undefined;
  // Process shutdown keeps provider documents; a failed initial open's
  // retained cleanup keeps its own policy, which closes them.
  let retainProviderDocuments = true;
  const sessionOwner = sessionCleanupOwner(
    session,
    () => retainProviderDocuments,
  );
  const cleanupOwners = [sessionOwner];
  // The attached transport's barrier before shared owners close.
  let prepareShutdown: (() => Promise<void>) | undefined;
  let startupSettled = false;
  let lastAttemptFailed = false;
  let shutdownUnregistered = false;
  let unregisterShutdown = (): void => undefined;
  const unregisterOnce = (): void => {
    if (shutdownUnregistered) return;
    unregisterShutdown();
    shutdownUnregistered = true;
  };
  const shutdown = async (): Promise<void> => {
    if (shutdownAttempt !== undefined) return shutdownAttempt;
    requested.abort();
    const pending = cleanupOwners.filter(
      ({ closed, deferred }) => !closed && !deferred,
    );
    const attempt = drainThenClose(prepareShutdown, pending).then((failure) => {
      lastAttemptFailed = failure !== undefined;
      if (failure !== undefined) throw failure.cause;
      if (startupSettled) unregisterOnce();
    });
    shutdownAttempt = attempt;
    // Settled attempts release the slot so a retry or a later-attached owner
    // starts a new attempt; closed owners are never closed again.
    const releaseSlot = (): void => {
      if (shutdownAttempt === attempt) shutdownAttempt = undefined;
    };
    void attempt.then(releaseSlot, releaseSlot);
    return attempt;
  };
  // A reported failure stays the outcome: a later retry that succeeds must not
  // turn an observed shutdown failure into a successful exit.
  let failureReported = false;
  const reportShutdown = (): Promise<0 | 1> =>
    shutdown().then(
      () => (failureReported ? 1 : 0),
      (cause: unknown) => {
        failureReported = true;
        reportMcpShutdownFailure(cause, dependencies, serverLogger);
        return 1 as const;
      },
    );
  const requestShutdown = (): void => {
    void reportShutdown();
  };
  const settleInFlight = async (): Promise<void> => {
    await shutdownAttempt?.catch(() => undefined);
  };
  // Complete a requested shutdown, including owners attached after it began.
  // A reported failure with no newer owner keeps its handlers for a retry.
  const finish = async (): Promise<0 | 1> => {
    await settleInFlight();
    startupSettled = true;
    if (lastAttemptFailed && cleanupOwners.every(({ attempted }) => attempted))
      return 1;
    return reportShutdown();
  };
  unregisterShutdown = dependencies.registerShutdown(requestShutdown);
  return {
    signal: requested.signal,
    attachTransport: (owners) => {
      // A transport attached after a request is closed by `finish`.
      if (!requested.signal.aborted) startupSettled = true;
      prepareShutdown = owners.handle?.prepareShutdown;
      cleanupOwners.unshift(...transportCleanupOwners(owners));
      // A server that started before this attachment can reopen the session
      // during or after an earlier attempt's close, so the next attempt closes
      // it again even if that close is still in flight.
      rearm(sessionOwner);
    },
    shutdown,
    request: requestShutdown,
    // A session close during the initial open would queue behind it and
    // replace a failed open's cleanup policy before startup could classify the
    // outcome, so the open's caller closes the session once it settles.
    whileOpening: (open) => deferWhile(sessionOwner, open),
    finish,
    // A failed initial open whose cleanup the session still retains: retry it
    // with that open's non-retaining policy, here and on any later request.
    finishFailedOpen: () => {
      retainProviderDocuments = false;
      return finish();
    },
    // Startup failed and closed its own resources; stop handling process events
    // unless a shutdown that raced it failed and retains owners for a retry.
    release: async () => {
      await settleInFlight();
      startupSettled = true;
      if (!lastAttemptFailed) unregisterOnce();
    },
  };
};

/** Close the session under the retention policy current at each attempt. */
const sessionCleanupOwner = (
  session: BinarySession,
  retainProviderDocuments: () => boolean,
): ShutdownCleanupOwner =>
  cleanupOwner(async () => {
    // Explicit on every attempt: an omitted option keeps the policy an
    // earlier attempt saved on the session's pending cleanup.
    const closed = await session.close({
      retainProviderDocuments: retainProviderDocuments(),
    });
    if (!closed.ok) throw closed.error;
  });

const cleanupOwner = (close: () => Promise<void>): ShutdownCleanupOwner => ({
  close,
  closed: false,
  attempted: false,
  deferred: false,
  generation: 0,
});

const rearm = (owner: ShutdownCleanupOwner): void => {
  owner.generation += 1;
  owner.closed = false;
};

const transportCleanupOwners = ({
  handle,
  closeAndroid,
  closeOptionalProviders,
}: McpTransportOwners): ShutdownCleanupOwner[] =>
  [
    handle === undefined ? undefined : () => handle.close(),
    closeAndroid,
    closeOptionalProviders,
  ].flatMap((close) => (close === undefined ? [] : [cleanupOwner(close)]));

const deferWhile = async <T>(
  owner: ShutdownCleanupOwner,
  operation: () => Promise<T>,
): Promise<T> => {
  owner.deferred = true;
  try {
    return await operation();
  } finally {
    owner.deferred = false;
  }
};

/**
 * Drain the transport, then close owners. HTTP handlers can still own provider
 * resources after cancellation, so a failed drain closes nothing and keeps
 * every owner for a later retry.
 */
const drainThenClose = async (
  prepareShutdown: (() => Promise<void>) | undefined,
  owners: readonly ShutdownCleanupOwner[],
): Promise<{ readonly cause: unknown } | undefined> => {
  try {
    await prepareShutdown?.();
  } catch (cause: unknown) {
    // The attempt covered these owners even though none of them closed.
    for (const owner of owners) owner.attempted = true;
    return { cause };
  }
  return closeOwners(owners);
};

/** Close owners concurrently and return their combined failure, if any. */
const closeOwners = async (
  owners: readonly ShutdownCleanupOwner[],
): Promise<{ readonly cause: unknown } | undefined> => {
  for (const owner of owners) owner.attempted = true;
  const results = await Promise.allSettled(
    owners.map(async (owner) => {
      const { generation } = owner;
      await owner.close();
      owner.closed = owner.generation === generation;
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length === 0) return undefined;
  return {
    cause:
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Multiple MCP cleanup operations failed",
          ),
  };
};

/** Preserve the same diagnostics for eager and deferred runtime owners. */
export const reportMcpShutdownFailure = (
  cause: unknown,
  dependencies: Pick<RuntimeDependencies, "writeStderr" | "setExitCode">,
  serverLogger: Logger,
): void => {
  serverLogger.debug(
    { failure_cause: describeShutdownFailure(cause) },
    "MCP shutdown rejected",
  );
  dependencies.setExitCode(1);
  serverLogger.error(MCP_SHUTDOWN_FAILED);
  dependencies.writeStderr(`${MCP_SHUTDOWN_FAILED}\n`);
  if (cause instanceof AnalysisError)
    dependencies.writeStderr(`${projectAnalysisError(cause).message}\n`);
};

const describeShutdownFailure = (
  cause: unknown,
): Readonly<Record<string, JsonValue>> =>
  describeShutdownFailureNode(cause, new WeakSet<object>());

const describeShutdownFailureNode = (
  cause: unknown,
  active: WeakSet<object>,
): Readonly<Record<string, JsonValue>> => {
  if (typeof cause === "object" && cause !== null) {
    if (active.has(cause)) return { type: "cyclic_error" };
    active.add(cause);
  }
  try {
    if (cause instanceof AnalysisError)
      return { analysis_error: projectAnalysisError(cause) };
    if (cause instanceof Error) {
      const code = "code" in cause ? cause.code : undefined;
      return {
        name: cause.name,
        message: cause.message,
        ...(typeof code === "string" ||
        (typeof code === "number" && Number.isFinite(code))
          ? { code }
          : {}),
        ...(cause instanceof AggregateError
          ? {
              errors: cause.errors.map((error: unknown) =>
                describeShutdownFailureNode(error, active),
              ),
            }
          : {}),
      };
    }
    if (
      cause === null ||
      typeof cause === "string" ||
      typeof cause === "boolean" ||
      (typeof cause === "number" && Number.isFinite(cause))
    )
      return { type: cause === null ? "null" : typeof cause, value: cause };
    return { type: typeof cause };
  } finally {
    if (typeof cause === "object" && cause !== null) active.delete(cause);
  }
};
