import { createHash } from "node:crypto";
import { access, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { SafeOutputSourceFailure } from "../../../src/artifacts/SafeOutputSourceFailure.js";
import { translateArtifactFailure } from "../../../src/artifacts/ArtifactOperationFailure.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../../src/artifacts/AnalysisCleanupLease.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { firmwareFailure } from "../../../src/firmware/FirmwareFailures.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const empty = {
  bytes: 0,
  sha256: createHash("sha256").update("").digest("hex"),
};

it.each(
  [false, true].flatMap((emitClose) =>
    (["setup", "read"] as const).flatMap((timing) =>
      (["emit", "end", "destroy"] as const).map((terminal) => ({
        emitClose,
        timing,
        terminal,
      })),
    ),
  ),
)(
  "settles observed source failure without waiting for another event: %j",
  async ({ emitClose, timing, terminal }) => {
    const root = await createTestTempDirectory("rea-setup-error-");
    const tree = await SafeOutputTree.create(join(root, "output"));
    const failure = new Error("source failed");
    let reads = 0;
    const fail = () => {
      source.emit("error", failure);
      if (terminal === "end") source.push(null);
      if (terminal === "destroy") source.destroy(failure);
    };
    const source = new Readable({
      emitClose,
      read() {
        reads++;
        if (timing === "read") fail();
      },
    });
    const pending = tree
      .write("file", source, empty)
      .catch((error: unknown) => error);
    if (timing === "setup") fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<"stalled">((resolve) => {
          timer = setTimeout(() => resolve("stalled"), 1000);
        }),
      ]);
      expect(result).not.toBe("stalled");
      expect(
        result === failure ||
          (result instanceof SafeOutputSourceFailure &&
            (result.cause === failure ||
              result.sourceFailures.includes(failure))),
      ).toBe(true);
      if (timing === "setup") expect(reads).toBe(0);
      expect(source.closed).toBe(true);
    } finally {
      clearTimeout(timer);
      source.destroy(new Error("test rescue"));
      await pending;
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      await expect(access(tree.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);

it.each(["cancel", "path", "cancel-and-error", "path-and-error"] as const)(
  "settles an idle source with %s and retains the observed primary",
  async (mode) => {
    const root = await createTestTempDirectory("rea-idle-source-");
    const tree = await SafeOutputTree.create(join(root, "output"));
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    if (mode.startsWith("cancel")) controller.abort(cancellation);
    const failure = new Error("source failed during setup");
    let reads = 0;
    const source = new Readable({
      read() {
        reads++;
      },
    });
    const pending = tree
      .write(
        mode.startsWith("path") ? "../outside" : "file",
        source,
        empty,
        controller.signal,
      )
      .catch((error: unknown) => error);
    if (mode.endsWith("error")) source.emit("error", failure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<"stalled">((resolve) => {
          timer = setTimeout(() => resolve("stalled"), 1000);
        }),
      ]);
      expect(result).not.toBe("stalled");
      if (mode.startsWith("path"))
        expect(result).toMatchObject({ reason: "path" });
      else if (mode === "cancel")
        expect(result).toMatchObject({
          reason: "cancelled",
          cause: cancellation,
        });
      else expect(result).toBe(failure);
      if (mode === "path-and-error")
        expect((result as SafeOutputSourceFailure).sourceFailures).toContain(
          failure,
        );
      expect(reads).toBe(0);
      expect(source.closed).toBe(true);
    } finally {
      clearTimeout(timer);
      source.destroy(new Error("test rescue"));
      await pending;
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      await expect(access(tree.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);

it.each(
  (["cancelled", "input", "unsupported"] as const).flatMap((kind) =>
    (["none", "primary", "secondary", "both", "unknown"] as const).flatMap(
      (owners) =>
        [false, true].map((emitClose) => ({ kind, owners, emitClose })),
    ),
  ),
)(
  "preserves the source primary's public semantics across cleanup: %j",
  async ({ kind, owners, emitClose }) => {
    const root = await createTestTempDirectory("rea-typed-source-");
    const paths = [join(root, "primary"), join(root, "secondary")];
    const handles = await Promise.all(
      paths.map(async (path) => {
        await writeFile(path, "owned");
        return open(path, "r");
      }),
    );
    const leases = handles.map(
      (handle, index) =>
        new AnalysisCleanupLease(() => handle.close(), [paths[index]!]),
    );
    const primaryCleanup =
      owners === "primary" || owners === "both" || owners === "unknown";
    const secondaryCleanup =
      owners === "secondary" || owners === "both" || owners === "unknown";
    const reason = new Error("original caller reason");
    const options = {
      cause: reason,
      ...(primaryCleanup
        ? {
            cleanup: { reason: "primary close failed", resources: [paths[0]!] },
          }
        : {}),
    };
    const primary =
      kind === "cancelled"
        ? new AnalysisCancelledError("extract_artifact", options)
        : kind === "input"
          ? new AnalysisInputError(
              "extract_artifact",
              { ...options, userMessage: "Correct the selected input" },
              [
                {
                  path: ["path"],
                  reason: "invalid_value",
                  message: "Choose an existing file",
                },
              ],
            )
          : new AnalysisUnsupportedTargetError(
              "extract_artifact",
              "input.bin",
              "unsupported format",
              { ...options, remediationAction: "Choose a supported input" },
            );
    if (primaryCleanup) new AnalysisCleanupLeaseGroup(primary, [leases[0]!]);
    const secondary = secondaryCleanup
      ? new ProviderCleanupError("fixture", [paths[1]!], {
          reason: "secondary close failed",
        })
      : new Error("later source error");
    if (secondary instanceof ProviderCleanupError && owners !== "unknown")
      new AnalysisCleanupLeaseGroup(secondary, [leases[1]!]);
    const tree = await SafeOutputTree.create(join(root, "output"));
    const source = new Readable({
      emitClose,
      read() {
        this.destroy(primary);
      },
      destroy(_error, callback) {
        this.emit("error", primary);
        setImmediate(() => callback(secondary));
      },
    });
    try {
      const raw = await tree
        .write("file", source, empty)
        .catch((error: unknown) => error);
      const artifact = translateArtifactFailure("extract_artifact", raw);
      const firmware = firmwareFailure(raw, {
        engine: "unblob",
        operation: "extract_firmware",
      });
      const before = projectAnalysisError(primary);
      for (const translated of [artifact, firmware]) {
        const projected = projectAnalysisError(translated);
        if (secondaryCleanup) {
          expect(projected.code).toBe("cleanup_incomplete");
          expect(projected.details?.diagnostics).toMatchObject({
            primary_error: before,
          });
          expect(translated.secondaryFailures).toContain(secondary);
        } else expect(projected).toMatchObject(before);
      }
      // Release both real handles in opposite orders, checking live attribution.
      for (const index of emitClose ? [0, 1] : [1, 0]) {
        await leases[index]!.release();
        await expect(handles[index]!.stat()).rejects.toMatchObject({
          code: "EBADF",
        });
        for (const translated of [artifact, firmware]) {
          if (index === 0 || owners !== "unknown")
            expect(translated.cleanupResources).not.toContain(paths[index]);
        }
      }
      for (const translated of [artifact, firmware]) {
        if (owners === "unknown") {
          expect(translated.cleanupIncomplete).toBe(true);
          expect(translated.cleanupResources).toEqual([paths[1]]);
        } else {
          expect(translated.cleanupIncomplete).toBe(false);
          const projected = projectAnalysisError(translated);
          expect(projected).toMatchObject(projectAnalysisError(primary));
          expect(projected.code).toBe(
            kind === "cancelled"
              ? "cancelled"
              : kind === "input"
                ? "invalid_request"
                : "unsupported_target",
          );
        }
      }
      expect(primary.cause).toBe(reason);
      expect(source.closed).toBe(true);
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      await expect(access(tree.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);

it.each(["cancelled", "input", "unsupported"] as const)(
  "retains the typed source primary through outer file cleanup: %s",
  async (kind) => {
    const root = await createTestTempDirectory("rea-typed-outer-");
    const path = join(root, "input");
    await writeFile(path, "owned");
    const scope = new ArtifactResourceScope();
    const tree = await SafeOutputTree.create(join(root, "output"));
    const primary =
      kind === "cancelled"
        ? new AnalysisCancelledError("extract_artifact", {
            cause: "caller reason",
          })
        : kind === "input"
          ? new AnalysisInputError("extract_artifact", undefined, [
              { path: ["path"], reason: "invalid_value" },
            ])
          : new AnalysisUnsupportedTargetError(
              "extract_artifact",
              path,
              "unsupported format",
              { remediationAction: "Select a supported file" },
            );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const raw = await withArtifactRegularFile(
        path,
        scope,
        undefined,
        async (handle) => {
          file = handle;
          vi.spyOn(handle, "close").mockRejectedValueOnce(
            new Error("outer close failed"),
          );
          const source = new Readable({
            read() {
              this.destroy(primary);
            },
            destroy(_error, callback) {
              this.emit("error", primary);
              setImmediate(() => callback(new Error("later source error")));
            },
          });
          await tree.write("file", source, empty);
        },
      ).catch((cause: unknown) => cause);
      const errors = [
        translateArtifactFailure("extract_artifact", raw),
        firmwareFailure(raw, {
          engine: "unblob",
          operation: "extract_firmware",
        }),
      ];
      expect(scope.hasPending).toBe(true);
      expect((await file!.stat()).size).toBe(5);
      for (const error of errors)
        expect(error.cleanupResources).toEqual([path]);
      await scope.retryCleanup();
      await expect(file!.stat()).rejects.toMatchObject({ code: "EBADF" });
      for (const error of errors) {
        expect(error.cleanupIncomplete).toBe(false);
        expect(projectAnalysisError(error)).toMatchObject(
          projectAnalysisError(primary),
        );
      }
    } finally {
      await scope.retryCleanup();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  },
);
