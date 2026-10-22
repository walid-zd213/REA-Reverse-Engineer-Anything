import { createHash } from "node:crypto";
import { access, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { SafeOutputSourceFailure } from "../../../src/artifacts/SafeOutputSourceFailure.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { readArtifactFileChunks } from "../../../src/artifacts/readArtifactFileChunks.js";
import { translateArtifactFailure } from "../../../src/artifacts/ArtifactOperationFailure.js";
import { firmwareFailure } from "../../../src/firmware/FirmwareFailures.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { AnalysisCleanupLease } from "../../../src/artifacts/AnalysisCleanupLease.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const expected = {
  bytes: 5,
  sha256: createHash("sha256").update("owned").digest("hex"),
};

it.each(
  [false, true].flatMap((emitClose) =>
    [false, true].flatMap((deferred) =>
      [false, true].map((failDestroy) => ({
        emitClose,
        deferred,
        failDestroy,
      })),
    ),
  ),
)(
  "joins source auto-destruction after normal end: %j",
  async ({ emitClose, deferred, failDestroy }) => {
    const root = await createTestTempDirectory("rea-normal-source-end-");
    const input = join(root, "input"),
      output = join(root, "output");
    await writeFile(input, "owned");
    const handle = await open(input, "r");
    const tree = await SafeOutputTree.create(output);
    const failure = new Error("source finalization failed");
    let closedAtSettlement = false;
    let destroyDone!: () => void;
    const destruction = new Promise<void>((resolve) => {
      destroyDone = resolve;
    });
    const source = new Readable({
      emitClose,
      read() {
        const buffer = Buffer.alloc(5);
        void handle.read(buffer, 0, 5, 0).then(
          ({ bytesRead }) => {
            this.push(buffer.subarray(0, bytesRead));
            this.push(null);
          },
          (error: unknown) => this.destroy(error as Error),
        );
      },
      destroy(error, callback) {
        void (async () => {
          if (deferred) await delay(100);
          await handle.close();
          callback(failDestroy ? failure : error);
          destroyDone();
        })();
      },
    });
    // Keep a broken implementation's late error from aborting this test worker.
    // A separate child-process probe checks the unhandled-error boundary.
    const observed: unknown[] = [];
    source.on("error", (error: unknown) => observed.push(error));
    try {
      const result = await tree.write("file", source, expected).then(
        (value) => {
          closedAtSettlement = source.closed;
          return value;
        },
        (error: unknown) => {
          closedAtSettlement = source.closed;
          return error;
        },
      );
      await destruction;
      expect(closedAtSettlement).toBe(true);
      if (failDestroy) {
        expect(result).toBe(failure);
        expect(observed).toContain(failure);
      } else expect(result).toMatchObject({ bytesWritten: 5 });
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await destruction;
      await handle.close();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(
  (["none", "cancelled", "io"] as const).flatMap((sourceFailure) =>
    [false, true].map((pathFailure) => ({ sourceFailure, pathFailure })),
  ),
)(
  "keeps read/cancellation outcomes separate from cleanup facts: %j",
  async ({ sourceFailure, pathFailure }) => {
    const root = await createTestTempDirectory("rea-secondary-source-state-");
    const input = join(root, "input"),
      output = join(root, "output");
    await writeFile(input, "owned");
    const tree = await SafeOutputTree.create(output);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    let closed = false;
    let inputHandle!: FileHandle;
    try {
      const result = await withArtifactRegularFile(
        input,
        resources,
        undefined,
        async (handle) => {
          inputHandle = handle;
          const source =
            sourceFailure === "io"
              ? new Readable({ read() {} })
              : readArtifactFileChunks(handle, { signal: controller.signal });
          if (sourceFailure === "io")
            source.destroy(
              new ArtifactReaderFailure("io", "controlled read failure"),
            );
          if (sourceFailure === "cancelled")
            controller.abort(
              new DOMException("controlled cancellation", "AbortError"),
            );
          try {
            return await tree.write(
              pathFailure ? "../outside" : "file",
              source,
              expected,
              controller.signal,
            );
          } finally {
            closed = source.closed;
          }
        },
      ).catch((cause: unknown) => cause);
      if (pathFailure || sourceFailure !== "none") {
        expect(result).toBeInstanceOf(ArtifactReaderFailure);
        const failure = result as ArtifactReaderFailure;
        expect(failure.reason).toBe(pathFailure ? "path" : sourceFailure);
        expect(failure.cleanup).toBeUndefined();
        const translated = translateArtifactFailure(
          "extract_artifact",
          failure,
        );
        const firmware = firmwareFailure(failure, {
          engine: "unblob",
          operation: "extract_firmware",
        });
        expect(translated.cleanupIncomplete).toBe(false);
        expect(firmware.cleanupIncomplete).toBe(false);
        const secondaryCount = pathFailure && sourceFailure !== "none" ? 1 : 0;
        expect(translated.secondaryFailures).toHaveLength(secondaryCount);
        expect(firmware.secondaryFailures).toHaveLength(secondaryCount);
      } else expect(result).toMatchObject({ bytesWritten: 5 });
      expect(closed).toBe(true);
      expect(resources.hasPending).toBe(false);
      await expect(inputHandle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await resources.close();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([false, true])(
  "retains an actual close owner after normal end (emitClose: %s)",
  async (emitClose) => {
    const root = await createTestTempDirectory("rea-normal-close-owner-");
    const input = join(root, "input");
    await writeFile(input, "owned");
    const handle = await open(input, "r");
    const lease = new AnalysisCleanupLease(() => handle.close(), [input]);
    const failure = new ArtifactReaderFailure("io", "source close failed", {
      cleanup: { reason: "source close failed", resources: [input] },
      cleanupLeases: [lease],
    });
    const tree = await SafeOutputTree.create(join(root, "output"));
    const source = new Readable({
      emitClose,
      read() {
        const buffer = Buffer.alloc(5);
        void handle.read(buffer, 0, 5, 0).then(
          ({ bytesRead }) => {
            this.push(buffer.subarray(0, bytesRead));
            this.push(null);
          },
          (error: unknown) => this.destroy(error as Error),
        );
      },
      destroy(_error, callback) {
        setImmediate(() => callback(failure));
      },
    });
    try {
      await expect(tree.write("file", source, expected)).rejects.toMatchObject({
        cause: failure,
        reason: failure.reason,
        cleanupLeases: [lease],
        primaryIsSource: true,
      });
      expect(source.closed).toBe(true);
      expect((await handle.stat()).size).toBe(5);
      const translated = translateArtifactFailure("extract_artifact", failure);
      expect(translated.cleanupIncomplete).toBe(true);
      await lease.release();
      expect(translated.cleanupIncomplete).toBe(false);
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await lease.release();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  },
);

it("leaves a non-auto-destroyed source with its caller after readable end", async () => {
  const root = await createTestTempDirectory("rea-source-owner-end-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  const source = new Readable({
    autoDestroy: false,
    read() {
      this.push(Buffer.from("owned"));
      this.push(null);
    },
  });
  try {
    await expect(tree.write("file", source, expected)).resolves.toMatchObject({
      bytesWritten: 5,
    });
    expect(source.destroyed).toBe(false);
    expect(source.listenerCount("error")).toBe(0);
  } finally {
    source.destroy();
    expect(await tree.rollback()).toEqual({
      status: "complete",
      residualPaths: [],
    });
  }
});

it.each(
  [false, true].flatMap((emitClose) =>
    [false, true].map((failDestroy) => ({ emitClose, failDestroy })),
  ),
)(
  "retains cancellation and source finalization failures in observed order: %j",
  async ({ emitClose, failDestroy }) => {
    const root = await createTestTempDirectory("rea-source-final-cancel-");
    const input = join(root, "input");
    await writeFile(input, "owned");
    const handle = await open(input, "r");
    const tree = await SafeOutputTree.create(join(root, "output"));
    const controller = new AbortController();
    const cancellation = new Error("cancelled during source finalization");
    const failure = new Error("source finalization failed");
    const source = new Readable({
      emitClose,
      read() {
        this.push(Buffer.from("owned"));
        this.push(null);
      },
      destroy(error, callback) {
        void (async () => {
          await delay(100);
          controller.abort(cancellation);
          await handle.close();
          callback(failDestroy ? failure : error);
        })();
      },
    });
    try {
      const result = await tree
        .write("file", source, expected, controller.signal)
        .catch((cause: unknown) => cause);
      if (failDestroy) {
        // Readback can observe cancellation before the deferred destroy error.
        // Either primary is valid, but a later source failure must survive.
        if (result instanceof SafeOutputSourceFailure) {
          expect(result.reason).toBe("cancelled");
          expect(result.cancellation?.reason).toBe(cancellation);
          expect(result.sourceFailures).toContain(failure);
        } else expect(result).toBe(failure);
      } else {
        expect(result).toBeInstanceOf(ArtifactReaderFailure);
        expect((result as ArtifactReaderFailure).reason).toBe("cancelled");
        expect((result as ArtifactReaderFailure).cancellation?.reason).toBe(
          cancellation,
        );
      }
      expect(source.closed).toBe(true);
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await handle.close();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  },
);
