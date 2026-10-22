import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  withArtifactFileHandle,
  bindArtifactFileCleanup,
} from "./ArtifactFileOperation.js";
import { ArtifactResourceRetryFailure } from "./ArtifactResourceScope.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createEvidence } from "../domain/evidence.js";
import { err } from "../domain/result.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import {
  ArtifactReaderFailure,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

it("waits for admitted operations and shares concurrent close", async () => {
  const scope = new ArtifactResourceScope();
  const started = deferred<void>();
  const finish = deferred<void>();
  const operation = scope.run(async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;

  const close = scope.close();
  expect(scope.close()).toBe(close);
  await expect(scope.run(async () => undefined)).rejects.toMatchObject({
    reason: "unavailable",
    message: "Artifact resource scope is closed",
  });
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);

  finish.resolve();
  await operation;
  await close;
  expect(closed).toBe(true);
});

it("stops a close hook even when retained cleanup is still failing", async () => {
  const scope = new ArtifactResourceScope();
  let releases = 0;
  const owner = {
    kind: "lease" as const,
    resource: "stuck lease",
    lease: {
      async release() {
        releases += 1;
        if (releases < 3) throw new Error("still owned");
      },
    },
  };
  expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
  let hookRuns = 0;
  scope.addCloseHook(async () => {
    hookRuns += 1;
    if (hookRuns === 1) throw new Error("hook still stopping");
  });

  const closeFailure = await scope.close().then(
    () => {
      throw new Error("close succeeded while cleanup and the hook failed");
    },
    (cause: unknown) => cause,
  );
  expect(closeFailure).toMatchObject({
    message: "Artifact cleanup remains incomplete: stuck lease, close hook",
    failedOwners: [owner],
    cleanup: {
      reason: "still owned; hook still stopping",
      resources: ["stuck lease", "close hook"],
    },
  });
  expect(closeFailure).toBeInstanceOf(ArtifactResourceRetryFailure);
  const causes = (closeFailure as ArtifactResourceRetryFailure).cause;
  expect(causes).toBeInstanceOf(AggregateError);
  expect(
    (causes as AggregateError).errors.map((error) =>
      error instanceof Error ? error.message : String(error),
    ),
  ).toEqual([
    "Artifact cleanup remains incomplete: stuck lease",
    "hook still stopping",
  ]);
  expect(releases).toBe(2);
  expect(hookRuns).toBe(1);
  await scope.close();
  expect(releases).toBe(3);
  expect(hookRuns).toBe(2);
});

it("runs later close hooks when an earlier hook fails", async () => {
  const scope = new ArtifactResourceScope();
  const order: string[] = [];
  scope.addCloseHook(async () => {
    order.push("first");
    throw new Error("first hook failed");
  });
  scope.addCloseHook(async () => {
    order.push("second");
    throw new Error("second hook failed");
  });

  const failure = await scope.close().then(
    () => {
      throw new Error("close succeeded while hooks failed");
    },
    (cause: unknown) => cause,
  );
  expect(order).toEqual(["first", "second"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(
    (failure as AggregateError).errors.map((error) =>
      error instanceof Error ? error.message : String(error),
    ),
  ).toEqual(["first hook failed", "second hook failed"]);

  order.length = 0;
  await expect(scope.close()).rejects.toBeInstanceOf(AggregateError);
  expect(order).toEqual(["first", "second"]);
});

it("retains the same failed reader owner in a retry failure and retries before admitting work", async () => {
  const scope = new ArtifactResourceScope();
  let closeAttempts = 0;
  const reader = {
    async close() {
      closeAttempts += 1;
      if (closeAttempts < 4) throw new Error(`close attempt ${closeAttempts}`);
    },
  } as unknown as ArtifactReader;
  const owner = { kind: "reader" as const, resource: "fixture reader", reader };

  expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
  expect(closeAttempts).toBe(1);

  await expect(scope.run(async () => "must not run")).rejects.toMatchObject({
    reason: "unavailable",
    message: "Artifact cleanup remains incomplete: fixture reader",
    failedOwners: [owner],
  });
  expect(closeAttempts).toBe(2);
  await expect(scope.close()).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect(closeAttempts).toBe(3);
  await scope.close();
  expect(closeAttempts).toBe(4);
});

it("reports only owners whose cleanup failed during a mixed retry", async () => {
  const scope = new ArtifactResourceScope();
  let firstAttempts = 0;
  let secondAttempts = 0;
  const first = {
    kind: "lease" as const,
    resource: "first lease",
    lease: {
      async release() {
        firstAttempts += 1;
        if (firstAttempts === 1) throw new Error("first initial close");
      },
    },
  };
  const second = {
    kind: "lease" as const,
    resource: "second lease",
    lease: {
      async release() {
        secondAttempts += 1;
        if (secondAttempts < 3) throw new Error("second close still denied");
      },
    },
  };
  expect(await scope.release(first)).toMatchObject({ kind: "failed" });
  expect(await scope.release(second)).toMatchObject({ kind: "failed" });
  expect(scope.cleanupResources).toEqual(["first lease", "second lease"]);

  await expect(scope.retryCleanup()).rejects.toMatchObject({
    failedOwners: [second],
    cleanup: { resources: ["second lease"] },
  });
  expect(firstAttempts).toBe(2);
  expect(secondAttempts).toBe(2);
  expect(scope.cleanupResources).toEqual(["second lease"]);
  await scope.close();
  expect(firstAttempts).toBe(2);
  expect(secondAttempts).toBe(3);
  expect(scope.cleanupResources).toEqual([]);
});

it("retains a failed source analyzer until shutdown can verify its release", async () => {
  const scope = new ArtifactResourceScope();
  let releaseAllowed = false;
  const failure = new AnalysisOutputError(
    "analyze_javascript_application",
    "Owned worker is still running",
  );
  const owner = {
    kind: "javascript-source-analysis" as const,
    resource: "fixture source analyzer",
    analysis: {
      async analyze() {
        return err({
          error: failure,
          javascript: null,
          module: null,
          projection: null,
        });
      },
      async close() {
        if (!releaseAllowed) throw failure;
      },
    },
  };
  expect(await scope.release(owner)).toMatchObject({
    kind: "failed",
    cause: failure,
    owner,
  });
  let admitted = false;
  await expect(
    scope.run(async () => {
      admitted = true;
    }),
  ).rejects.toMatchObject({
    cleanup: { resources: ["fixture source analyzer"] },
  });
  expect(admitted).toBe(false);
  await expect(scope.close()).rejects.toMatchObject({
    cleanup: { resources: ["fixture source analyzer"] },
  });
  releaseAllowed = true;
  await scope.close();
});

it("retains a canonical retry lease for a plain cleanup capability", async () => {
  const scope = new ArtifactResourceScope();
  let denied = true;
  let closes = 0;
  const owner = {
    kind: "lease",
    resource: "plain cleanup owner",
    lease: {
      release: async () => {
        closes++;
        if (denied) throw new Error("close denied");
      },
    },
  } as const;
  try {
    expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
    const retry: unknown = await scope
      .retryCleanup()
      .catch((cause: unknown) => cause);
    if (!(retry instanceof ArtifactResourceRetryFailure))
      throw new Error("Expected exact failed owners");
    expect(retry.cleanupLeases).toHaveLength(1);
    const failure = new ProviderCleanupError("fixture", [owner.resource], {
      reason: "close denied",
    });
    bindArtifactFileCleanup(retry, failure);
    expect(failure.cleanupIncomplete).toBe(true);
    denied = false;
    await scope.close();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
    expect(closes).toBe(3);
  } finally {
    denied = false;
    await scope.close();
  }
});

it("binds initial mixed cleanup to only its unresolved owners", async () => {
  const scope = new ArtifactResourceScope();
  let denyFirst = true,
    denySecond = true;
  const first = {
    kind: "lease" as const,
    resource: "first",
    lease: {
      async release() {
        if (denyFirst) throw new Error("first denied");
      },
    },
  };
  const second = {
    kind: "lease" as const,
    resource: "second",
    lease: {
      async release() {
        if (denySecond) throw new Error("second denied");
      },
    },
  };
  try {
    const a = await scope.release(first),
      b = await scope.release(second);
    if (a.kind !== "failed" || b.kind !== "failed")
      throw new Error("Expected owned cleanup failures");
    const initial = scope.cleanupFailure({ kind: "completed" }, [a, b]);
    expect(initial.cleanupLeases).toEqual([a.lease, b.lease]);
    const error = translateArtifactFailure("inventory_artifact", initial);
    denyFirst = false;
    const retry = await scope.retryCleanup().catch((cause: unknown) => cause);
    expect(retry).toBeInstanceOf(ArtifactResourceRetryFailure);
    if (!(retry instanceof ArtifactResourceRetryFailure))
      throw new Error("Expected failed second owner");
    expect(retry.cleanupLeases).toEqual([b.lease]);
    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupResources).toEqual(["second"]);
    denySecond = false;
    await scope.retryCleanup();
    expect(error.cleanupIncomplete).toBe(false);
    expect(error.cleanupResources).toEqual([]);
  } finally {
    denyFirst = false;
    denySecond = false;
    await scope.close();
  }
});

it("keeps a typed cleanup classification when the operation itself completed", async () => {
  const scope = new ArtifactResourceScope();
  let denied = true;
  const owner = {
    kind: "lease" as const,
    resource: "typed owner",
    lease: {
      async release() {
        if (denied)
          throw new ArtifactReaderFailure("unavailable", "typed close denied");
      },
    },
  };
  try {
    const attempt = await scope.release(owner);
    if (attempt.kind !== "failed") throw new Error("Expected owned failure");
    const error = translateArtifactFailure(
      "extract_artifact",
      scope.cleanupFailure({ kind: "completed" }, [attempt]),
    );
    expect(error).toMatchObject({
      reason: "unavailable",
      cleanup: { resources: ["typed owner"] },
    });
  } finally {
    denied = false;
    await scope.close();
  }
});

it.each(["owned-close", "independent-primary"] as const)(
  "keeps the scope of unknown cleanup explicit: %s",
  async (kind) => {
    const scope = new ArtifactResourceScope();
    let denied = true;
    const unknown = new ArtifactReaderFailure("io", "unknown cleanup", {
      cleanup: { resources: ["unverified"], reason: "no capability" },
    });
    const owner = {
      kind: "lease" as const,
      resource: "known owner",
      lease: {
        async release() {
          if (denied) throw unknown;
        },
      },
    };
    try {
      const attempt = await scope.release(owner);
      if (attempt.kind !== "failed") throw new Error("Expected owned failure");
      const outcome =
        kind === "owned-close"
          ? { kind: "completed" as const }
          : { kind: "failed" as const, cause: unknown };
      const initial = scope.cleanupFailure(outcome, [attempt]);
      const error = translateArtifactFailure("inventory_artifact", initial);
      expect(error.cleanupIncomplete).toBe(true);
      denied = false;
      await scope.close();
      expect(attempt.lease.released).toBe(true);
      expect(error.cleanupIncomplete).toBe(kind === "independent-primary");
      expect(initial.cleanupLeases === undefined).toBe(
        kind === "independent-primary",
      );
    } finally {
      denied = false;
      await scope.close();
    }
  },
);

it.each([undefined, null, { reason: "opaque reason" }])(
  "retains cancellation provenance through initial cleanup and recovery: %j",
  async (reason) => {
    const scope = new ArtifactResourceScope();
    let denied = true;
    const owner = {
      kind: "lease" as const,
      resource: "cancelled reader",
      lease: {
        async release() {
          if (denied) throw new Error("denied");
        },
      },
    };
    try {
      const attempt = await scope.release(owner);
      if (attempt.kind !== "failed") throw new Error("Expected owned failure");
      const primary = new ArtifactReaderFailure(
        "cancelled",
        "primary cancelled",
        { cancellation: { reason } },
      );
      const initial = scope.cleanupFailure({ kind: "failed", cause: primary }, [
        attempt,
      ]);
      expect(initial.reason).toBe("cancelled");
      expect(initial.cancellation?.reason).toBe(reason);
      const error = translateArtifactFailure("inventory_artifact", initial);
      expect(error.cause).toBe(reason);
      denied = false;
      await scope.close();
      expect(error.cleanupIncomplete).toBe(false);
      expect(error.cause).toBe(reason);
    } finally {
      denied = false;
      await scope.close();
    }
  },
);

it("does not clear independent domain cleanup when a new scope owner releases", async () => {
  const scope = new ArtifactResourceScope();
  let denied = true;
  const primary = new ProviderCleanupError("independent", ["other resource"], {
    reason: "unknown authority",
  });
  const owner = {
    kind: "lease" as const,
    resource: "new owner",
    lease: {
      async release() {
        if (denied) throw new Error("denied");
      },
    },
  };
  try {
    const attempt = await scope.release(owner);
    if (attempt.kind !== "failed") throw new Error("Expected owned failure");
    const initial = scope.cleanupFailure({ kind: "failed", cause: primary }, [
      attempt,
    ]);
    const error = translateArtifactFailure("inventory_artifact", initial);
    denied = false;
    await scope.close();
    expect(attempt.lease.released).toBe(true);
    expect(primary.cleanupIncomplete).toBe(true);
    expect(error.cleanupIncomplete).toBe(true);
    expect(initial.cleanupLeases).toBeUndefined();
    expect(initial.cleanup?.resources).toContain("other resource");
  } finally {
    denied = false;
    await scope.close();
  }
});

it.each(["completed", "failed"] as const)(
  "preserves physical file ownership separately from a typed close rejection after %s work",
  async (outcome) => {
    const directory = await createTestTempDirectory(
      "rea-scope-file-authority-",
    );
    const path = join(directory, "payload");
    await writeFile(path, "selected bytes");
    const file = await open(path, "r");
    const close = file.close.bind(file);
    const scope = new ArtifactResourceScope();
    let denied = true;
    const primary = new ProviderCleanupError(
      "independent",
      ["independent resource"],
      { reason: "unverified primary" },
    );
    const closeCause = new ProviderCleanupError("file-close", [path], {
      reason: "close denied",
    });
    file.close = async () => {
      if (denied) throw closeCause;
      await close();
    };
    try {
      const failure = await withArtifactFileHandle(
        path,
        file,
        scope,
        undefined,
        async () => {
          if (outcome === "failed") throw primary;
          return 42;
        },
      ).catch((cause: unknown) => cause);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("Expected physical file failure");
      const error = translateArtifactFailure("inventory_artifact", failure);
      expect(error.cleanupIncomplete).toBe(true);
      denied = false;
      await scope.close();
      expect(file.fd).toBe(-1);
      expect(error.cleanupIncomplete).toBe(outcome === "failed");
      expect(failure.cleanupLeases === undefined).toBe(outcome === "failed");
    } finally {
      denied = false;
      await scope.close();
      await close();
    }
  },
);

it.each(["artifact", "domain"] as const)(
  "keeps initial %s composite labels current when a later close retains only one child",
  async (kind) => {
    const scope = new ArtifactResourceScope();
    let children = ["first child", "second child"];
    const owner = {
      kind: "lease" as const,
      resource: "composite owner",
      lease: {
        async release() {
          if (children.length > 0) {
            if (kind === "domain")
              throw new ProviderCleanupError("composite", [...children], {
                reason: "held children",
              });
            throw new ArtifactReaderFailure("io", "child close denied", {
              cleanup: { reason: "held children", resources: [...children] },
            });
          }
        },
      },
    };
    try {
      const attempt = await scope.release(owner);
      if (attempt.kind !== "failed")
        throw new Error("Expected retained children");
      const error = translateArtifactFailure(
        "inventory_artifact",
        scope.cleanupFailure({ kind: "completed" }, [attempt]),
      );
      expect(error.cleanupResources).toEqual(children);
      children = ["second child"];
      await expect(scope.retryCleanup()).rejects.toMatchObject({
        cleanupLeases: [attempt.lease],
      });
      expect(error.cleanupIncomplete).toBe(true);
      expect(error.cleanupResources).toEqual(children);
      expect(scope.cleanupResources).toEqual(children);
      children = [];
      await scope.close();
      expect(error.cleanupIncomplete).toBe(false);
      expect(error.cleanupResources).toEqual([]);
    } finally {
      children = [];
      await scope.close();
    }
  },
);

it.each(
  ["completed", "failed"].flatMap((outcome) =>
    [false, true].flatMap((nested) =>
      [false, true].map((releaseBeforeConversion) => ({
        outcome,
        nested,
        releaseBeforeConversion,
      })),
    ),
  ),
)(
  "retains scope composition and observations across retries: %j",
  async ({ outcome, nested, releaseBeforeConversion }) => {
    const scope = new ArtifactResourceScope();
    let denied = true;
    const partial = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: null },
      {
        operation: "inspect",
        parameters: {},
        result: { retained_fact: true },
        confidence: "observed",
        locations: [],
        limitations: [],
      },
    );
    const primary = new ArtifactReaderFailure("limit", "file-size bound", {
      boundary: "file-size",
    });
    const attempt = async (resource: string) => {
      const result = await scope.release({
        kind: "lease",
        resource,
        lease: {
          async release() {
            if (denied) throw new Error("close denied");
          },
        },
      });
      if (result.kind !== "failed") throw new Error("Expected retained owner");
      return result;
    };
    try {
      const first = await attempt("first");
      let raw = scope.cleanupFailure(
        outcome === "failed"
          ? { kind: "failed", cause: primary }
          : { kind: "completed" },
        [first],
        partial,
      );
      if (nested)
        raw = scope.cleanupFailure(
          { kind: "failed", cause: raw },
          [await attempt("second")],
          partial,
        );
      if (outcome === "failed") expect(raw.boundary).toBe("file-size");
      if (releaseBeforeConversion) {
        denied = false;
        await scope.retryCleanup();
      }
      const error = translateArtifactFailure("inventory_artifact", raw);
      expect(error.cleanupIncomplete).toBe(!releaseBeforeConversion);
      expect(error.cleanupResources).toEqual(
        releaseBeforeConversion ? [] : nested ? ["first", "second"] : ["first"],
      );
      expect(projectAnalysisError(error).details?.partial_observation).toEqual(
        partial,
      );
      denied = false;
      await scope.retryCleanup();
      expect(error.cleanupIncomplete).toBe(false);
      expect(error.cleanupResources).toEqual([]);
      expect(projectAnalysisError(error).details?.partial_observation).toEqual(
        partial,
      );
      if (outcome === "failed")
        expect(projectAnalysisError(error).code).toBe(
          projectAnalysisError(
            translateArtifactFailure("inventory_artifact", primary),
          ).code,
        );
    } finally {
      denied = false;
      await scope.close();
    }
  },
);
