import { expect, it } from "vitest";

import type {
  AnalysisClient,
  ExecutionOptions,
} from "../../../src/application/AnalysisProvider.js";
import type { OptionalProviderLoadResult } from "../../../src/application/OptionalObservationProviders.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { err, ok } from "../../../src/domain/result.js";
import { run } from "../../../src/main.js";
import { MCP_SHUTDOWN_FAILED } from "../../../src/main/messages.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

type RuntimeDependencies = NonNullable<Parameters<typeof run>[0]>;

const runtime = (
  overrides: Partial<RuntimeDependencies> & {
    readonly requests: Array<() => void>;
    readonly unregistrations: string[];
    readonly output: string[];
  },
): RuntimeDependencies => ({
  env: {},
  serve: () => {
    throw new Error("Transport must not start");
  },
  writeStderr: (text) => overrides.output.push(text),
  setExitCode: () => undefined,
  registerShutdown: (handler) => {
    overrides.requests.push(handler);
    return () => overrides.unregistrations.push("shutdown");
  },
  loadOptionalProviders: async () => ({}),
  ...overrides,
});

it("closes the session when a signal arrives during the initial open, joining a repeated signal during cleanup", async () => {
  const [target] = await createBinarySessionTargets();
  const healthSignal = createDeferred<AbortSignal | undefined>();
  const closeStarted = createDeferred<void>();
  const releaseClose = createDeferred<void>();
  const closeOptions: unknown[] = [];
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: (_operation, _parameters, options?: ExecutionOptions) => {
      healthSignal.resolve(options?.signal);
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () =>
          resolve(err(new AnalysisCancelledError("health"))),
        );
      });
    },
    close: async (options) => {
      closeOptions.push(options);
      closeStarted.resolve();
      await releaseClose.promise;
      return ok(null);
    },
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  let serveCalls = 0;
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      serve: () => {
        serveCalls += 1;
        throw new Error("Transport must not start");
      },
      requests,
      unregistrations,
      output,
    }),
  );

  const signal = await healthSignal.promise;
  expect(requests).toHaveLength(1);
  requests[0]?.();
  expect(signal?.aborted).toBe(true);
  await closeStarted.promise;
  requests[0]?.();
  releaseClose.resolve();

  await expect(running).resolves.toBe(0);
  // Process shutdown keeps provider documents, such as a Hopper GUI document.
  expect(closeOptions).toEqual([{ retainDocument: true }]);
  expect(serveCalls).toBe(0);
  expect(unregistrations).toEqual(["shutdown"]);
  expect(output).toEqual([]);
  expect(await session.status()).toMatchObject({ open: false });
});

it("starts no transport after a shutdown request during provider loading and keeps handlers until the loaded providers close", async () => {
  const providersLoading = createDeferred<void>();
  const releaseProviders = createDeferred<void>();
  const providerCloseStarted = createDeferred<void>();
  const releaseProviderClose = createDeferred<void>();
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  let serveCalls = 0;
  let providerCloses = 0;
  const running = run(
    runtime({
      serve: () => {
        serveCalls += 1;
        throw new Error("Transport must not start");
      },
      loadOptionalProviders: async () => {
        providersLoading.resolve();
        await releaseProviders.promise;
        return {
          browserObservation: {
            close: async () => {
              providerCloses += 1;
              providerCloseStarted.resolve();
              await releaseProviderClose.promise;
            },
          } as unknown as NonNullable<
            OptionalProviderLoadResult["browserObservation"]
          >,
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await providersLoading.promise;
  requests[0]?.();
  releaseProviders.resolve();
  // The session attempt has settled before the late provider owner closes.
  await providerCloseStarted.promise;
  expect(unregistrations).toEqual([]);
  requests[0]?.();
  releaseProviderClose.resolve();

  await expect(running).resolves.toBe(0);
  expect(serveCalls).toBe(0);
  expect(providerCloses).toBe(1);
  expect(unregistrations).toEqual(["shutdown"]);
  expect(output).toEqual([]);
  requests[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  expect(providerCloses).toBe(1);
});

it("keeps a reported startup shutdown failure as the outcome when the late-owner retry succeeds", async () => {
  const [target] = await createBinarySessionTargets();
  const providersLoading = createDeferred<void>();
  const releaseProviders = createDeferred<void>();
  let closeFails = true;
  let clientCloses = 0;
  let providerCloses = 0;
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: async () => observed(null),
    close: async () => {
      clientCloses += 1;
      return closeFails
        ? err(new AnalysisOutputError("close", "fixture close failed"))
        : ok(null);
    },
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const exitCodes: number[] = [];
  const failureReported = createDeferred<void>();
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      setExitCode: (code) => {
        exitCodes.push(code);
        failureReported.resolve();
      },
      loadOptionalProviders: async () => {
        providersLoading.resolve();
        await releaseProviders.promise;
        return {
          browserObservation: {
            close: async () => {
              providerCloses += 1;
            },
          } as unknown as NonNullable<
            OptionalProviderLoadResult["browserObservation"]
          >,
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await providersLoading.promise;
  requests[0]?.();
  // The session-only attempt fails and is reported before providers attach.
  await failureReported.promise;
  expect(exitCodes).toEqual([1]);
  closeFails = false;
  releaseProviders.resolve();

  await expect(running).resolves.toBe(1);
  expect(clientCloses).toBe(2);
  expect(providerCloses).toBe(1);
  expect(
    output.filter(
      (line) =>
        line ===
        `${MCP_SHUTDOWN_FAILED}
`,
    ),
  ).toHaveLength(1);
  expect(unregistrations).toEqual(["shutdown"]);
});

it("closes a transport whose start raced a shutdown request", async () => {
  const serveStarted = createDeferred<void>();
  const releaseServe = createDeferred<void>();
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  let handleCloses = 0;
  const running = run(
    runtime({
      serve: async () => {
        serveStarted.resolve();
        await releaseServe.promise;
        return {
          close: async () => {
            handleCloses += 1;
          },
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await serveStarted.promise;
  requests[0]?.();
  releaseServe.resolve();

  await expect(running).resolves.toBe(0);
  expect(handleCloses).toBe(1);
  expect(unregistrations).toEqual(["shutdown"]);
  expect(output).toEqual([]);
});

it("closes a session reopened by a server whose start raced a shutdown request", async () => {
  const [target] = await createBinarySessionTargets();
  let clientCloses = 0;
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: async () => observed(null),
    close: async () => {
      clientCloses += 1;
      return ok(null);
    },
  }));
  const serveStarted = createDeferred<void>();
  const releaseServe = createDeferred<void>();
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  let handleCloses = 0;
  const running = run(
    runtime({
      createSession: () => session,
      serve: async () => {
        serveStarted.resolve();
        await releaseServe.promise;
        // A request the live server admitted before `serve` resolved.
        expect((await session.open(target)).ok).toBe(true);
        return {
          close: async () => {
            handleCloses += 1;
          },
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await serveStarted.promise;
  requests[0]?.();
  // The request's session close settles before the server reopens it.
  await new Promise((resolve) => setImmediate(resolve));
  releaseServe.resolve();

  await expect(running).resolves.toBe(0);
  expect(handleCloses).toBe(1);
  expect(clientCloses).toBe(1);
  expect(await session.status()).toMatchObject({ open: false });
  expect(unregistrations).toEqual(["shutdown"]);
  expect(output).toEqual([]);
});

it("closes a session reopened behind a raced close that settles after the transport attaches", async () => {
  const [initialTarget, reopenedTarget] = await createBinarySessionTargets();
  const firstCloseStarted = createDeferred<void>();
  const releaseFirstClose = createDeferred<void>();
  let clientCloses = 0;
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: async () => observed(null),
    close: async () => {
      clientCloses += 1;
      if (clientCloses === 1) {
        firstCloseStarted.resolve();
        await releaseFirstClose.promise;
      }
      return ok(null);
    },
  }));
  const serveStarted = createDeferred<void>();
  const releaseServe = createDeferred<void>();
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  let reopened: Promise<unknown> | undefined;
  let handleCloses = 0;
  const running = run(
    runtime({
      env: {
        HOPPER_TARGET_PATH: initialTarget,
        HOPPER_TARGET_KIND: "database",
      },
      createSession: () => session,
      serve: async () => {
        serveStarted.resolve();
        await releaseServe.promise;
        // A request the live server admitted queues behind the raced close.
        reopened = session.open(reopenedTarget);
        return {
          prepareShutdown: async () => {
            await reopened;
          },
          close: async () => {
            handleCloses += 1;
          },
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await serveStarted.promise;
  requests[0]?.();
  await firstCloseStarted.promise;
  releaseServe.resolve();
  // The transport attaches while the first close is still in flight.
  await expect.poll(() => reopened !== undefined).toBe(true);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstClose.resolve();

  await expect(running).resolves.toBe(0);
  expect(await reopened).toMatchObject({ ok: true });
  expect(handleCloses).toBe(1);
  expect(clientCloses).toBe(2);
  expect(await session.status()).toMatchObject({ open: false });
  expect(unregistrations).toEqual(["shutdown"]);
  expect(output).toEqual([]);
});

it("treats a cancelled open that reports its own incomplete cleanup as the shutdown's", async () => {
  const [target] = await createBinarySessionTargets();
  const healthStarted = createDeferred<void>();
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: (_operation, _parameters, options?: ExecutionOptions) => {
      healthStarted.resolve();
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () =>
          resolve(
            err(
              new AnalysisCancelledError("health", {
                cleanup: {
                  reason: "fixture preflight handle close unconfirmed",
                  resources: ["fixture-handle"],
                },
              }),
            ),
          ),
        );
      });
    },
    close: async () => ok(null),
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      requests,
      unregistrations,
      output,
    }),
  );

  await healthStarted.promise;
  requests[0]?.();

  // The shutdown owns the outcome; no initial-open failure is reported.
  await expect(running).resolves.toBe(0);
  expect(output).toEqual([]);
  expect(unregistrations).toEqual(["shutdown"]);
});

it("reports a failed startup shutdown once and retains its handler for a retry", async () => {
  const [target] = await createBinarySessionTargets();
  const healthStarted = createDeferred<void>();
  let closeFails = true;
  let clientCloses = 0;
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: (_operation, _parameters, options?: ExecutionOptions) => {
      healthStarted.resolve();
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () =>
          resolve(err(new AnalysisCancelledError("health"))),
        );
      });
    },
    close: async () => {
      clientCloses += 1;
      return closeFails
        ? err(new AnalysisOutputError("close", "fixture close failed"))
        : ok(null);
    },
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const exitCodes: number[] = [];
  const unregistered = createDeferred<void>();
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      setExitCode: (code) => exitCodes.push(code),
      registerShutdown: (handler) => {
        requests.push(handler);
        return () => {
          unregistrations.push("shutdown");
          unregistered.resolve();
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await healthStarted.promise;
  requests[0]?.();

  await expect(running).resolves.toBe(1);
  // The aborted open and the shutdown attempt each tried the client once.
  expect(clientCloses).toBe(2);
  expect(exitCodes).toEqual([1]);
  expect(
    output.filter(
      (line) =>
        line ===
        `${MCP_SHUTDOWN_FAILED}
`,
    ),
  ).toHaveLength(1);
  expect(unregistrations).toEqual([]);

  closeFails = false;
  requests[0]?.();
  await unregistered.promise;
  expect(unregistrations).toEqual(["shutdown"]);
  expect(clientCloses).toBe(3);
  expect(await session.status()).toMatchObject({ open: false });
});

it.each([
  ["succeeds", false],
  ["fails", true],
] as const)(
  "reports an open failure that preceded a shutdown request whose cleanup %s",
  async (_label, cleanupFails) => {
    const [target] = await createBinarySessionTargets();
    const openFailure = new AnalysisTimeoutError("health", 1_000);
    const closeStarted = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    let closeFails = cleanupFails;
    let clientCloses = 0;
    const closeOptions: unknown[] = [];
    const session = createTestBinarySession((): AnalysisClient => ({
      execute: async () => err(openFailure),
      close: async (options) => {
        clientCloses += 1;
        closeOptions.push(options);
        closeStarted.resolve();
        await releaseClose.promise;
        return closeFails
          ? err(new AnalysisOutputError("close", "fixture close failed"))
          : ok(null);
      },
    }));
    const requests: Array<() => void> = [];
    const unregistrations: string[] = [];
    const output: string[] = [];
    const unregistered = createDeferred<void>();
    const running = run(
      runtime({
        env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
        createSession: () => session,
        registerShutdown: (handler) => {
          requests.push(handler);
          return () => {
            unregistrations.push("shutdown");
            unregistered.resolve();
          };
        },
        requests,
        unregistrations,
        output,
      }),
    );

    // The request arrives while the session finalizes the failed open.
    await closeStarted.promise;
    requests[0]?.();
    releaseClose.resolve();

    await expect(running).resolves.toBe(1);
    expect(output).toContain(`${projectAnalysisError(openFailure).message}\n`);
    expect(output.includes(`${MCP_SHUTDOWN_FAILED}\n`)).toBe(cleanupFails);
    if (!cleanupFails) {
      expect(unregistrations).toEqual(["shutdown"]);
      return;
    }
    // The failed shutdown keeps its handler, so a repeated request retries.
    expect(unregistrations).toEqual([]);
    const attempts = clientCloses;
    closeFails = false;
    requests[0]?.();
    await unregistered.promise;
    expect(clientCloses).toBe(attempts + 1);
    expect(await session.status()).toMatchObject({ open: false });
    // The raced shutdown saved a retaining policy; the failed open's retry
    // must still close provider documents.
    expect(closeOptions.at(-1)).not.toEqual(
      expect.objectContaining({ retainDocument: true }),
    );
  },
);

it("closes provider documents when a provider failure races the shutdown signal", async () => {
  const [target] = await createBinarySessionTargets();
  const openFailure = new AnalysisTimeoutError("health", 1_000);
  const healthStarted = createDeferred<void>();
  const closeOptions: unknown[] = [];
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: (_operation, _parameters, options?: ExecutionOptions) => {
      healthStarted.resolve();
      // The signal aborts first, but the provider reports its own failure.
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () =>
          resolve(err(openFailure)),
        );
      });
    },
    close: async (options) => {
      closeOptions.push(options);
      return ok(null);
    },
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      requests,
      unregistrations,
      output,
    }),
  );

  await healthStarted.promise;
  requests[0]?.();

  await expect(running).resolves.toBe(1);
  expect(output).toContain(`${projectAnalysisError(openFailure).message}\n`);
  expect(closeOptions.length).toBeGreaterThan(0);
  expect(closeOptions).not.toContainEqual(
    expect.objectContaining({ retainDocument: true }),
  );
  expect(await session.status()).toMatchObject({ cleanup_pending: false });
  expect(unregistrations).toEqual(["shutdown"]);
});

it("keeps a failed open's document policy when a raced shutdown retry succeeds", async () => {
  const [target] = await createBinarySessionTargets();
  const openFailure = new AnalysisTimeoutError("health", 1_000);
  const closeStarted = createDeferred<void>();
  const releaseClose = createDeferred<void>();
  const closeOptions: unknown[] = [];
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: async () => err(openFailure),
    close: async (options) => {
      closeOptions.push(options);
      if (closeOptions.length > 1) return ok(null);
      // Only the failed open's own first close fails.
      closeStarted.resolve();
      await releaseClose.promise;
      return err(new AnalysisOutputError("close", "fixture close failed"));
    },
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      requests,
      unregistrations,
      output,
    }),
  );

  await closeStarted.promise;
  requests[0]?.();
  releaseClose.resolve();

  await expect(running).resolves.toBe(1);
  expect(output).toContain(`${projectAnalysisError(openFailure).message}\n`);
  expect(closeOptions.length).toBeGreaterThan(1);
  expect(closeOptions).not.toContainEqual(
    expect.objectContaining({ retainDocument: true }),
  );
  expect(await session.status()).toMatchObject({
    open: false,
    cleanup_pending: false,
  });
  expect(unregistrations).toEqual(["shutdown"]);
});

it("keeps shutdown registered when a failed initial open retains session cleanup", async () => {
  const [target] = await createBinarySessionTargets();
  const openFailure = new AnalysisTimeoutError("health", 1_000);
  let closeFails = true;
  let clientCloses = 0;
  const closeOptions: unknown[] = [];
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: async () => err(openFailure),
    close: async (options) => {
      clientCloses += 1;
      closeOptions.push(options);
      return closeFails
        ? err(new AnalysisOutputError("close", "fixture close failed"))
        : ok(null);
    },
  }));
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const unregistered = createDeferred<void>();
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
      createSession: () => session,
      registerShutdown: (handler) => {
        requests.push(handler);
        return () => {
          unregistrations.push("shutdown");
          unregistered.resolve();
        };
      },
      requests,
      unregistrations,
      output,
    }),
  );

  await expect(running).resolves.toBe(1);
  expect(clientCloses).toBe(3);
  expect(await session.status()).toMatchObject({ cleanup_pending: true });
  expect(unregistrations).toEqual([]);
  expect(output).toContain(`${projectAnalysisError(openFailure).message}\n`);
  expect(output).toContain(`${MCP_SHUTDOWN_FAILED}\n`);

  closeFails = false;
  requests[0]?.();
  await unregistered.promise;
  expect(clientCloses).toBe(4);
  expect(await session.status()).toMatchObject({
    open: false,
    cleanup_pending: false,
  });
  expect(unregistrations).toEqual(["shutdown"]);
  // Every retry keeps the failed open's policy: provider documents close.
  expect(closeOptions).not.toContainEqual(
    expect.objectContaining({ retainDocument: true }),
  );
});

it("closes the session and unregisters when startup throws unexpectedly", async () => {
  const session = createTestBinarySession((): AnalysisClient => ({
    execute: async () => err(new AnalysisCancelledError("health")),
    close: async () => ok(null),
  }));
  const failure = new Error("unexpected open failure");
  session.open = () => Promise.reject(failure);
  const close = session.close.bind(session);
  let sessionCloses = 0;
  session.close = (options) => {
    sessionCloses += 1;
    return close(options);
  };
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  const output: string[] = [];
  const running = run(
    runtime({
      env: { HOPPER_TARGET_PATH: "/fixture/target.hop" },
      createSession: () => session,
      requests,
      unregistrations,
      output,
    }),
  );

  await expect(running).rejects.toBe(failure);
  expect(sessionCloses).toBe(1);
  expect(unregistrations).toEqual(["shutdown"]);
  expect(output).toEqual([]);
});
