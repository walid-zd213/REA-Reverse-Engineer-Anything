import { createHash } from "node:crypto";
import { access, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { AnalysisCleanupLease } from "../../../src/artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { SafeOutputSourceFailure } from "../../../src/artifacts/SafeOutputSourceFailure.js";
import { FirmwareFileAccess } from "../../../src/firmware/FirmwareFiles.js";
import { normalizeUnblobReport } from "../../../src/firmware/FirmwareReports.js";
import { publishFirmwareExtraction } from "../../../src/firmware/FirmwarePublication.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { firmwareFailure } from "../../../src/firmware/FirmwareFailures.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const expected = {
  bytes: 5,
  sha256: createHash("sha256").update("owned").digest("hex"),
};
const context = { engine: "unblob", operation: "extract_firmware" };
type Mode = "unknown" | "exact" | "mixed";

const fixture = async (mode: Mode) => {
  const root = await createTestTempDirectory("rea-firmware-source-owners-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  await tree.write("seed", Readable.from("owned"), expected);
  const handles: FileHandle[] = [];
  let exact: FileHandle | undefined;
  let lease: AnalysisCleanupLease | undefined;
  const failures: ArtifactReaderFailure[] = [];
  for (const kind of ["unknown", "exact"] as const) {
    if (mode !== kind && mode !== "mixed") continue;
    const path = join(root, kind);
    await writeFile(path, "owned");
    const handle = await open(path, "r");
    handles.push(handle);
    if (kind === "exact") {
      exact = handle;
      lease = new AnalysisCleanupLease(() => handle.close(), [path]);
    }
    failures.push(
      new ArtifactReaderFailure("io", `${kind} source close failed`, {
        cleanup: { reason: `${kind} source close failed`, resources: [path] },
        ...(kind === "exact" ? { cleanupLeases: [lease!] } : {}),
      }),
    );
  }
  const source = (normalEnd = false) =>
    new Readable({
      read() {
        if (!normalEnd) throw new Error("refused input must not be read");
        this.push(Buffer.from("owned"));
        this.push(null);
      },
      destroy(_error, callback) {
        setImmediate(() => callback(failures.at(-1)));
      },
    });
  const writeFailure = async (destination = tree) => {
    const input = source();
    const pending = destination
      .write("../outside", input, expected)
      .catch((cause: unknown) => cause);
    if (mode === "mixed") input.emit("error", failures[0]);
    const failure = await pending;
    expect(failure).toBeInstanceOf(SafeOutputSourceFailure);
    return failure;
  };
  return {
    root,
    tree,
    handles,
    exact,
    lease,
    failures,
    source,
    writeFailure,
    async close() {
      await lease?.release();
      await Promise.all(handles.map((handle) => handle.close()));
      await tree.rollback();
    },
  };
};

it.each(
  (["unknown", "exact", "mixed"] as const).flatMap((mode) =>
    [false, true].flatMap((withTree) =>
      [false, true].flatMap((failRollback) =>
        [false, true].map((sourceFirst) => ({
          mode,
          withTree,
          failRollback,
          sourceFirst,
        })),
      ),
    ),
  ),
)(
  "keeps source ownership separate from tree rollback: %j",
  async ({ mode, withTree, failRollback, sourceFirst }) => {
    const f = await fixture(mode);
    const treeLease = new AnalysisCleanupLease(() =>
      f.tree.rollback().then(() => undefined),
    );
    try {
      const raw = await f.writeFailure();
      const error = firmwareFailure(raw, {
        ...context,
        ...(withTree ? { treeCleanupLease: treeLease } : {}),
      });
      expect(error.cleanupIncomplete).toBe(true);
      expect(projectAnalysisError(error).code).toBe("cleanup_incomplete");
      if (sourceFirst) await f.lease?.release();
      if (failRollback) {
        vi.spyOn(f.tree, "rollback").mockRejectedValueOnce(
          new Error("controlled tree rollback refusal"),
        );
        await expect(treeLease.release()).rejects.toThrow(
          "controlled tree rollback refusal",
        );
        expect(treeLease.released).toBe(false);
        await expect(access(f.tree.outputRoot)).resolves.toBeUndefined();
      }
      await treeLease.release();
      await expect(access(f.tree.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(error.cleanupIncomplete).toBe(mode !== "exact" || !sourceFirst);
      if (!sourceFirst && f.exact) expect((await f.exact.stat()).size).toBe(5);
      await f.lease?.release();
      if (f.exact)
        await expect(f.exact.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(error.cleanupIncomplete).toBe(mode !== "exact");
      const projected = projectAnalysisError(error);
      expect(projected.code === "cleanup_incomplete").toBe(mode !== "exact");
      if (mode !== "exact") {
        expect((await f.handles[0]!.stat()).size).toBe(5);
        expect(projected.details?.resources).toEqual([join(f.root, "unknown")]);
      }
    } finally {
      await f.close();
    }
  },
);

it.each(["unknown", "exact"] as const)(
  "keeps a sole normal-end source cleanup failure with its source: %s",
  async (mode) => {
    const f = await fixture(mode);
    try {
      const raw = await f.tree
        .write("normal", f.source(true), expected)
        .catch((cause: unknown) => cause);
      const treeLease = new AnalysisCleanupLease(() =>
        f.tree.rollback().then(() => undefined),
      );
      const error = firmwareFailure(raw, {
        ...context,
        treeCleanupLease: treeLease,
      });
      await treeLease.release();
      expect(error.cleanupIncomplete).toBe(true);
      expect((await f.handles[0]!.stat()).size).toBe(5);
      await f.lease?.release();
      expect(error.cleanupIncomplete).toBe(mode === "unknown");
    } finally {
      await f.close();
    }
  },
);

it.each([false, true])(
  "retains primary tree cleanup independently of exact source retry (source first: %s)",
  async (sourceFirst) => {
    const f = await fixture("exact");
    try {
      const primary = new ArtifactReaderFailure("path", "tree close failed", {
        cleanup: {
          reason: "tree close failed",
          resources: [f.tree.outputRoot],
        },
      });
      const raw = new SafeOutputSourceFailure(primary, f.failures);
      const treeLease = new AnalysisCleanupLease(() =>
        f.tree.rollback().then(() => undefined),
      );
      const error = firmwareFailure(raw, {
        ...context,
        treeCleanupLease: treeLease,
      });
      if (sourceFirst) await f.lease!.release();
      else await treeLease.release();
      expect(error.cleanupIncomplete).toBe(true);
      expect(error.cleanupResources).toEqual([
        sourceFirst ? f.tree.outputRoot : join(f.root, "exact"),
      ]);
      if (sourceFirst) await treeLease.release();
      else await f.lease!.release();
      expect(error.cleanupIncomplete).toBe(false);
      await expect(f.exact!.stat()).rejects.toMatchObject({ code: "EBADF" });
      await expect(access(f.tree.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.close();
    }
  },
);

it("does not lend tree ownership to an unknown source wrapped by a real file close failure", async () => {
  const f = await fixture("unknown");
  const resources = new ArtifactResourceScope();
  let outer: FileHandle | undefined;
  try {
    const raw = await withArtifactRegularFile(
      join(f.root, "unknown"),
      resources,
      undefined,
      async (handle) => {
        outer = handle;
        vi.spyOn(handle, "close").mockRejectedValueOnce(
          new Error("controlled exact outer close refusal"),
        );
        throw await f.writeFailure();
      },
    ).catch((cause: unknown) => cause);
    const treeLease = new AnalysisCleanupLease(() =>
      f.tree.rollback().then(() => undefined),
    );
    const error = firmwareFailure(raw, {
      ...context,
      treeCleanupLease: treeLease,
    });
    await treeLease.release();
    expect(error.cleanupIncomplete).toBe(true);
    expect(resources.hasPending).toBe(true);
    expect((await outer!.stat()).size).toBe(5);
    await resources.retryCleanup();
    await expect(outer!.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(error.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(error).code).toBe("cleanup_incomplete");
    expect((await f.handles[0]!.stat()).size).toBe(5);
  } finally {
    await resources.close();
    await f.close();
  }
});

it.each(
  (["unknown", "exact", "mixed"] as const).flatMap((mode) =>
    [false, true].map((failRollback) => ({ mode, failRollback })),
  ),
)(
  "keeps source and output cleanup independent through publication: %j",
  async ({ mode, failRollback }) => {
    const f = await fixture(mode);
    const files = new FirmwareFileAccess();
    const retained: AnalysisCleanupLease[] = [];
    const outputDirectory = join(f.root, "published");
    const inputPath = join(f.root, mode === "exact" ? "exact" : "unknown");
    const controller = new AbortController();
    const normalized = normalizeUnblobReport(
      [
        {
          task: {
            path: inputPath,
            depth: 0,
            blob_id: "root",
            is_multi_file: false,
          },
          reports: [
            { __typename__: "HashReport", sha256: expected.sha256 },
            {
              __typename__: "StatReport",
              path: inputPath,
              size: 5,
              is_dir: false,
              is_file: true,
              is_link: false,
              link_target: null,
            },
          ],
          subtasks: [],
        },
      ],
      {
        inputPath,
        outputRoot: f.root,
        sha256: expected.sha256,
        length: 5,
        offset: 0,
        maxDepth: 3,
      },
    );
    vi.spyOn(files, "hash").mockResolvedValue(expected.sha256);
    vi.spyOn(files, "publish").mockImplementation(
      async (_entry, _sha, tree) => {
        await tree.write("seed", Readable.from("owned"), expected);
        if (failRollback)
          vi.spyOn(tree, "rollback").mockRejectedValueOnce(
            new Error("controlled output rollback refusal"),
          );
        throw await f.writeFailure(tree);
      },
    );
    try {
      const raw = await publishFirmwareExtraction({
        files,
        workspacePath: f.root,
        analysisTimeoutMs: 120_000,
        outputDirectory,
        entries: [
          {
            relativePath: "file",
            path: inputPath,
            size: 5,
            kind: "file",
            linkTarget: null,
          },
        ],
        normalized,
        selection: { offset: 0, length: 5, sha256: expected.sha256 },
        maxDepth: 3,
        engine: {
          name: "unblob",
          version: "26.6.4",
          executable_path: "injected-no-execution",
          executable_sha256: expected.sha256,
          source_revision: null,
          worker_count: 1,
        },
        signal: controller.signal,
        deadline: {
          phase: "publication",
          signal: controller.signal,
          timeoutMs: 120000,
          expiresAtMs: performance.now() + 120000,
        },
        retainCleanup(_tree, lease, failure) {
          lease.bindCleanupError(failure);
          retained.push(lease);
        },
      }).catch((cause: unknown) => cause);
      expect(raw).toBeInstanceOf(AnalysisError);
      const error = raw as AnalysisError;
      expect(error.cleanupIncomplete).toBe(true);
      expect(projectAnalysisError(error).code).toBe("cleanup_incomplete");
      for (const handle of f.handles)
        expect((await handle.stat()).size).toBe(5);
      expect(retained).toHaveLength(failRollback ? 1 : 0);
      if (failRollback)
        await expect(access(outputDirectory)).resolves.toBeUndefined();
      await Promise.all(retained.map((lease) => lease.release()));
      await expect(access(outputDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(error.cleanupIncomplete).toBe(true);
      await f.lease?.release();
      expect(error.cleanupIncomplete).toBe(mode !== "exact");
      if (f.exact)
        await expect(f.exact.stat()).rejects.toMatchObject({ code: "EBADF" });
      if (mode !== "exact") {
        expect((await f.handles[0]!.stat()).size).toBe(5);
        expect(projectAnalysisError(error).details?.resources).toEqual([
          join(f.root, "unknown"),
        ]);
      }
    } finally {
      await Promise.all(retained.map((lease) => lease.release()));
      await files.close();
      await f.close();
    }
  },
);

it.each(
  (["exact", "mixed"] as const).flatMap((mode) =>
    [false, true].map((deadline) => ({ mode, deadline })),
  ),
)(
  "preserves the primary cancellation and source secondaries through retry: %j",
  async ({ mode, deadline }) => {
    const f = await fixture(mode);
    const controller = new AbortController();
    const reason = new DOMException(
      "controlled publication cancellation",
      deadline ? "TimeoutError" : "AbortError",
    );
    controller.abort(reason);
    try {
      const primary = new ArtifactReaderFailure(
        "cancelled",
        "publication cancelled",
        { cause: reason },
      );
      const raw = new SafeOutputSourceFailure(primary, f.failures);
      const treeLease = new AnalysisCleanupLease(() =>
        f.tree.rollback().then(() => undefined),
      );
      const error = firmwareFailure(raw, {
        ...context,
        treeCleanupLease: treeLease,
        ...(deadline
          ? {
              deadline: {
                phase: "publication" as const,
                signal: controller.signal,
                timeoutMs: 120000,
                expiresAtMs: performance.now() + 120000,
              },
            }
          : {}),
      });
      expect(error.cleanupPrimary?.cause).toBe(reason);
      expect(error.secondaryFailures).toHaveLength(f.failures.length);
      await treeLease.release();
      expect(error.cleanupIncomplete).toBe(true);
      await f.lease!.release();
      expect(error.cleanupIncomplete).toBe(mode === "mixed");
      expect(projectAnalysisError(error).code).toBe(
        mode === "mixed"
          ? "cleanup_incomplete"
          : deadline
            ? "provider_timeout"
            : "cancelled",
      );
      await expect(f.exact!.stat()).rejects.toMatchObject({ code: "EBADF" });
      if (mode === "mixed") expect((await f.handles[0]!.stat()).size).toBe(5);
    } finally {
      await f.close();
    }
  },
);

it("preserves source ownership when the primary read failure also reports unknown cleanup", async () => {
  const f = await fixture("mixed");
  try {
    const source = new Readable({
      read() {
        this.emit("error", f.failures[0]);
      },
      destroy(_error, callback) {
        setImmediate(() => callback(f.failures[1]));
      },
    });
    const raw = await f.tree
      .write("read-failure", source, expected)
      .catch((cause: unknown) => cause);
    expect(raw).toMatchObject({
      primaryIsSource: true,
      cause: f.failures[0],
      sourceFailures: [f.failures[1]],
    });
    const treeLease = new AnalysisCleanupLease(() =>
      f.tree.rollback().then(() => undefined),
    );
    const error = firmwareFailure(raw, {
      ...context,
      treeCleanupLease: treeLease,
    });
    await treeLease.release();
    expect(error.cleanupIncomplete).toBe(true);
    await f.lease!.release();
    expect(error.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(error).details?.resources).toEqual([
      join(f.root, "unknown"),
    ]);
    expect((await f.handles[0]!.stat()).size).toBe(5);
    await expect(f.exact!.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    await f.close();
  }
});
