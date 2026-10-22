import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../../src/artifacts/AnalysisCleanupLease.js";
import { translateArtifactFailure } from "../../../src/artifacts/ArtifactOperationFailure.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const sourcePrimary = (
  kind: "cancelled" | "input" | "unsupported",
  input: string,
  options: ConstructorParameters<typeof AnalysisCancelledError>[1],
) =>
  kind === "cancelled"
    ? new AnalysisCancelledError("extract_artifact", options)
    : kind === "input"
      ? new AnalysisInputError(
          "extract_artifact",
          { ...options, userMessage: "Choose valid input" },
          [{ path: ["path"], reason: "invalid_value" }],
        )
      : new AnalysisUnsupportedTargetError(
          "extract_artifact",
          input,
          "unsupported source",
          { ...options, remediationAction: "Choose supported input" },
        );

it.each(
  (["cancelled", "input", "unsupported"] as const).flatMap((kind) =>
    (["plain", "exact", "unknown"] as const).flatMap((sourceOwner) =>
      (["none", "reader", "tree", "both"] as const).flatMap((outer) =>
        [false, true].map((sourceFirst) => ({
          kind,
          sourceOwner,
          outer,
          sourceFirst,
        })),
      ),
    ),
  ),
)(
  "retains source semantics and independent owners through extraction cleanup: %j",
  async ({ kind, sourceOwner, outer, sourceFirst }) => {
    const root = await createTestTempDirectory("rea-extraction-source-scope-");
    const input = join(root, "input"),
      output = join(root, "output");
    const sourcePath = join(root, "source-owned"),
      readerPath = join(root, "reader-owned");
    await mkdir(input);
    await writeFile(join(input, "file"), "owned");
    await writeFile(sourcePath, "source");
    await writeFile(readerPath, "reader");
    const sourceFile = await open(sourcePath, "r"),
      readerFile = await open(readerPath, "r");
    const sourceLease = new AnalysisCleanupLease(
      () => sourceFile.close(),
      [sourcePath],
    );
    const cause = new Error("original cancellation reason");
    const options = {
      cause,
      ...(sourceOwner === "plain"
        ? {}
        : {
            cleanup: { reason: "source close failed", resources: [sourcePath] },
          }),
    };
    const primary = sourcePrimary(kind, input, options);
    if (sourceOwner === "exact")
      new AnalysisCleanupLeaseGroup(primary, [sourceLease]);
    const scope = new ArtifactResourceScope();
    let materializing = false,
      readerAttempts = 0,
      rollbackAttempts = 0;
    let tree: SafeOutputTree | undefined;
    const originalCreate = SafeOutputTree.create;
    const originalOpen = DirectoryArtifactReader.prototype.open;
    const originalClose = DirectoryArtifactReader.prototype.close;
    vi.spyOn(SafeOutputTree, "create").mockImplementation(async (...args) => {
      tree = await originalCreate(...args);
      materializing = true;
      const rollback = tree.rollback.bind(tree);
      vi.spyOn(tree, "rollback").mockImplementation(async () => {
        rollbackAttempts++;
        if ((outer === "tree" || outer === "both") && rollbackAttempts === 1)
          throw new Error("controlled first rollback failure");
        return rollback();
      });
      return tree;
    });
    vi.spyOn(DirectoryArtifactReader.prototype, "open").mockImplementation(
      async function (this: DirectoryArtifactReader, ...args) {
        if (!materializing) return originalOpen.apply(this, args);
        return new Readable({
          read() {
            this.destroy(primary);
          },
          destroy(_error, callback) {
            this.emit("error", primary);
            setImmediate(() => callback(new Error("secondary source event")));
          },
        });
      },
    );
    vi.spyOn(DirectoryArtifactReader.prototype, "close").mockImplementation(
      async function (this: DirectoryArtifactReader) {
        if (!materializing) return originalClose.call(this);
        readerAttempts++;
        if ((outer === "reader" || outer === "both") && readerAttempts === 1)
          throw new Error("controlled first reader close failure");
        await readerFile.close();
        return originalClose.call(this);
      },
    );
    try {
      const raw = await extractArtifact({
        inputPath: input,
        inputFormat: "app-pack",
        outputRoot: output,
        environment: {},
        integrityPolicy: "fail",
        resourceScope: scope,
      }).catch((error: unknown) => error);
      expect(materializing).toBe(true);
      const error = translateArtifactFailure("extract_artifact", raw);
      const expectedResources = () => [
        ...(sourceOwner === "unknown" ||
        (sourceOwner === "exact" && !sourceLease.released)
          ? [sourcePath]
          : []),
        ...scope.cleanupResources,
      ];
      const assertCurrent = () => {
        const resources = expectedResources();
        expect(error.cleanupIncomplete).toBe(resources.length > 0);
        expect([...error.cleanupResources].sort()).toEqual(
          [...resources].sort(),
        );
        const projection = projectAnalysisError(error);
        if (resources.length > 0) {
          expect(projection.code).toBe("cleanup_incomplete");
          expect(projection.details?.resources).toEqual(
            expect.arrayContaining(resources),
          );
          expect(projection.details?.resources).toHaveLength(resources.length);
        } else {
          expect(projection).toMatchObject(projectAnalysisError(primary));
          expect(projection.code).toBe(
            kind === "cancelled"
              ? "cancelled"
              : kind === "input"
                ? "invalid_request"
                : "unsupported_target",
          );
        }
      };
      assertCurrent();
      if (sourceFirst && sourceOwner === "exact") {
        await sourceLease.release();
        assertCurrent();
      }
      await scope.retryCleanup();
      expect(scope.hasPending).toBe(false);
      await expect(readerFile.stat()).rejects.toMatchObject({ code: "EBADF" });
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      assertCurrent();
      if (sourceOwner === "exact") {
        await sourceLease.release();
        await expect(sourceFile.stat()).rejects.toMatchObject({
          code: "EBADF",
        });
        assertCurrent();
      } else if (sourceOwner === "unknown") {
        expect((await sourceFile.stat()).size).toBe(6);
        expect(error.cleanupResources).toEqual([sourcePath]);
      }
      expect(primary.cause).toBe(cause);
    } finally {
      // Permit retry even when an earlier assertion failed.
      readerAttempts = Math.max(1, readerAttempts);
      rollbackAttempts = Math.max(1, rollbackAttempts);
      await scope.close();
      await tree?.rollback();
      await sourceFile.close();
      await readerFile.close();
      vi.restoreAllMocks();
    }
  },
);

it("extracts unchanged directory bytes without cleanup injection", async () => {
  const root = await createTestTempDirectory("rea-extraction-normal-");
  const input = join(root, "input"),
    output = join(root, "output");
  await mkdir(input);
  await writeFile(join(input, "file"), "owned");
  const scope = new ArtifactResourceScope();
  try {
    const result = await extractArtifact({
      inputPath: input,
      inputFormat: "app-pack",
      outputRoot: output,
      environment: {},
      integrityPolicy: "fail",
      resourceScope: scope,
    });
    expect(result.artifacts).toHaveLength(1);
    expect(await readFile(join(output, "file"), "utf8")).toBe("owned");
    expect(scope.hasPending).toBe(false);
  } finally {
    await scope.close();
  }
});
