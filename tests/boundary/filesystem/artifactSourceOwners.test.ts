import { access, open, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../../src/artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { translateArtifactFailure } from "../../../src/artifacts/ArtifactOperationFailure.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { firmwareFailure } from "../../../src/firmware/FirmwareFailures.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const expected = {
  bytes: 5,
  sha256: createHash("sha256").update("owned").digest("hex"),
};
const context = { engine: "unblob", operation: "extract_firmware" };
type Representation = "leases" | "domain";
const fixture = async (
  representation: Representation,
  unknownPeer: boolean,
) => {
  const root = await createTestTempDirectory("rea-live-source-owners-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  const paths = [join(root, "first"), join(root, "second")];
  const handles: FileHandle[] = [];
  for (const path of paths) {
    await writeFile(path, "owned");
    handles.push(await open(path, "r"));
  }
  const leases = handles.map(
    (handle, index) =>
      new AnalysisCleanupLease(() => handle.close(), [paths[index]!]),
  );
  const leaf = new ProviderCleanupError(
    "controlled-source",
    paths,
    { reason: "source close failed" },
    { operation: "extract_artifact" },
  );
  new AnalysisCleanupLeaseGroup(leaf, leases);
  const failure =
    representation === "domain"
      ? new ProviderAdapterError("controlled-source", "extract_artifact", {
          cause: leaf,
          cleanup: { reason: "source close failed", resources: paths },
        }).bindCleanupDependencies([leaf])
      : new ArtifactReaderFailure("io", "source close failed", {
          cleanup: { reason: "source close failed", resources: paths },
          cleanupLeases: leases,
        });
  const unknownPath = join(root, "unknown");
  let unknown: FileHandle | undefined;
  if (unknownPeer) {
    await writeFile(unknownPath, "owned");
    unknown = await open(unknownPath, "r");
  }
  const peer = new ArtifactReaderFailure("io", "unknown source close failed", {
    cleanup: {
      reason: "unknown source close failed",
      resources: [unknownPath],
    },
  });
  const writeFailure = async (sourcePrimary: boolean) => {
    const source = new Readable({
      read() {
        if (sourcePrimary) this.emit("error", failure);
        else throw new Error("refused input must not be read");
      },
      destroy(_error, callback) {
        setImmediate(() =>
          callback(sourcePrimary && unknownPeer ? peer : failure),
        );
      },
    });
    const pending = tree
      .write(sourcePrimary ? "file" : "../outside", source, expected)
      .catch((cause: unknown) => cause);
    if (!sourcePrimary && unknownPeer) source.emit("error", peer);
    const raw = await pending;
    expect(source.closed).toBe(true);
    return raw;
  };
  return {
    root,
    tree,
    paths,
    handles,
    leases,
    failure,
    leaf,
    unknown,
    unknownPath,
    writeFailure,
    async close() {
      await Promise.all(leases.map((lease) => lease.release()));
      await unknown?.close();
      await tree.rollback();
    },
  };
};

const assertLive = (error: AnalysisError, resources: readonly string[]) => {
  expect(error.cleanupIncomplete).toBe(resources.length > 0);
  expect([...error.cleanupResources].sort()).toEqual([...resources].sort());
  const projected = projectAnalysisError(error);
  expect(projected.code === "cleanup_incomplete").toBe(resources.length > 0);
  if (resources.length > 0)
    expect((projected.details?.resources as string[]).toSorted()).toEqual(
      [...resources].sort(),
    );
  else expect(projected.details?.cleanup).toBeUndefined();
  for (const child of error.secondaryFailures) {
    if (child.cleanupIncomplete)
      for (const path of child.cleanupResources)
        expect(resources).toContain(path);
    else expect(child.cleanupResources).toEqual([]);
  }
};

it.each(
  (["leases", "domain"] as const).flatMap((representation) =>
    [false, true].flatMap((unknownPeer) =>
      [false, true].flatMap((sourcePrimary) =>
        [false, true].flatMap((withTree) =>
          [false, true].map((sourceFirst) => ({
            representation,
            unknownPeer,
            sourcePrimary,
            withTree,
            sourceFirst,
          })),
        ),
      ),
    ),
  ),
)(
  "projects live source owners through both converters: %j",
  async ({
    representation,
    unknownPeer,
    sourcePrimary,
    withTree,
    sourceFirst,
  }) => {
    const f = await fixture(representation, unknownPeer);
    const treeLease = new AnalysisCleanupLease(() =>
      f.tree.rollback().then(() => undefined),
    );
    try {
      const raw = await f.writeFailure(sourcePrimary);
      const errors = [
        translateArtifactFailure("extract_artifact", raw),
        firmwareFailure(raw, {
          ...context,
          ...(withTree ? { treeCleanupLease: treeLease } : {}),
        }),
      ];
      const remaining = [...f.paths, ...(unknownPeer ? [f.unknownPath] : [])];
      for (const error of errors) assertLive(error, remaining);
      if (!sourceFirst) await treeLease.release();
      await f.leases[0]!.release();
      await expect(f.handles[0]!.stat()).rejects.toMatchObject({
        code: "EBADF",
      });
      expect((await f.handles[1]!.stat()).size).toBe(5);
      remaining.shift();
      for (const error of errors) assertLive(error, remaining);
      if (sourceFirst) await treeLease.release();
      await f.leases[1]!.release();
      await expect(f.handles[1]!.stat()).rejects.toMatchObject({
        code: "EBADF",
      });
      remaining.shift();
      for (const error of errors) assertLive(error, remaining);
      expect(f.leaf.cleanupIncomplete).toBe(false);
      if (f.failure instanceof AnalysisError)
        expect(f.failure.cleanupIncomplete).toBe(false);
      if (f.unknown) expect((await f.unknown.stat()).size).toBe(5);
      await expect(access(f.tree.outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.close();
    }
  },
);

it.each(
  (["leases", "domain"] as const).flatMap((representation) =>
    [false, true].flatMap((unknownPeer) =>
      [false, true].map((sourceFirst) => ({
        representation,
        unknownPeer,
        sourceFirst,
      })),
    ),
  ),
)(
  "preserves inherited live source owners through an exact outer file close failure: %j",
  async ({ representation, unknownPeer, sourceFirst }) => {
    const f = await fixture(representation, unknownPeer),
      scope = new ArtifactResourceScope();
    const outerPath = join(f.root, "outer");
    await writeFile(outerPath, "outer");
    let outer: FileHandle | undefined;
    try {
      const raw = await withArtifactRegularFile(
        outerPath,
        scope,
        undefined,
        async (handle) => {
          outer = handle;
          vi.spyOn(handle, "close").mockRejectedValueOnce(
            new Error("controlled outer close refusal"),
          );
          throw await f.writeFailure(false);
        },
      ).catch((cause: unknown) => cause);
      const treeLease = new AnalysisCleanupLease(() =>
        f.tree.rollback().then(() => undefined),
      );
      const errors = [
        translateArtifactFailure("extract_artifact", raw),
        firmwareFailure(raw, { ...context, treeCleanupLease: treeLease }),
      ];
      const unknown = unknownPeer ? [f.unknownPath] : [];
      for (const error of errors)
        assertLive(error, [...f.paths, outerPath, ...unknown]);
      await treeLease.release();
      if (sourceFirst) {
        await Promise.all(f.leases.map((lease) => lease.release()));
        for (const error of errors) assertLive(error, [outerPath, ...unknown]);
      } else {
        await scope.retryCleanup();
        await expect(outer!.stat()).rejects.toMatchObject({ code: "EBADF" });
        for (const error of errors) assertLive(error, [...f.paths, ...unknown]);
      }
      await scope.retryCleanup();
      await Promise.all(f.leases.map((lease) => lease.release()));
      for (const error of errors) assertLive(error, unknown);
      await expect(outer!.stat()).rejects.toMatchObject({ code: "EBADF" });
      for (const handle of f.handles)
        await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(scope.hasPending).toBe(false);
      if (f.unknown) expect((await f.unknown.stat()).size).toBe(5);
    } finally {
      await scope.close();
      await f.close();
    }
  },
);

it.each([false, true])(
  "does not revive domain cleanup released before conversion (source primary: %s)",
  async (sourcePrimary) => {
    const f = await fixture("domain", false);
    try {
      const raw = await f.writeFailure(sourcePrimary);
      await Promise.all(f.leases.map((lease) => lease.release()));
      for (const error of [
        translateArtifactFailure("extract_artifact", raw),
        firmwareFailure(raw, context),
      ])
        assertLive(error, []);
      for (const handle of f.handles)
        await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await f.close();
    }
  },
);
