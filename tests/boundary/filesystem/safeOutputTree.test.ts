import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { SafeOutputSourceFailure } from "../../../src/artifacts/SafeOutputSourceFailure.js";
import { SafeOutputTreeCreationFailure } from "../../../src/artifacts/SafeOutputTreeCreationFailure.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { readArtifactFileChunks } from "../../../src/artifacts/readArtifactFileChunks.js";

describe("safe artifact output cleanup", () => {
  it("adopts an empty caller directory without taking authority to remove it", async () => {
    const parent = await createTestTempDirectory("rea-admitted-output-");
    const output = join(parent, "output");
    await mkdir(output);
    const tree = await SafeOutputTree.create(output, process.platform, {
      acceptExistingEmpty: true,
    });
    await tree.write("file", Readable.from([Buffer.from("owned")]), {
      bytes: 5,
      sha256: createHash("sha256").update("owned").digest("hex"),
    });
    await tree.rollback();
    expect(await readdir(output)).toEqual([]);
    await tree.closeHandles();
  });
  it.skipIf(process.platform !== "linux")(
    "closes the parent descriptor when the output disappears before commit",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-");
      const output = join(parent, "published");
      const tree = await SafeOutputTree.create(output);
      await rm(output, { recursive: true });
      await expect(tree.commit()).rejects.toThrow();
      const targets = await Promise.all(
        (await readdir("/proc/self/fd")).map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => undefined),
        ),
      );
      expect(targets.filter((target) => target === parent)).toEqual([]);
      const failure = await tree.rollback().catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(failure).toMatchObject({ cleanup: { resources: [output] } });
      expect(tree.cleanup).toEqual({
        status: "incomplete",
        residualPaths: ["published"],
      });
      await rm(parent, { recursive: true, force: true });
    },
  );
});

describe("safe artifact output file identity admission", () => {
  it.skipIf(process.platform === "win32")(
    "retains an O_EXCL file handle until its identity can be retried",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-admit-");
      const output = join(parent, "published");
      const destination = join(output, "payload.txt");
      const displaced = join(parent, "owned-payload.txt");
      const outside = join(parent, "outside.txt");
      await writeFile(outside, "outside bytes");
      const prototypeHandle = await open(join(parent, "handle"), "w");
      const handlePrototype = Object.getPrototypeOf(prototypeHandle) as Pick<
        typeof prototypeHandle,
        "stat"
      >;
      await prototypeHandle.close();
      await rm(join(parent, "handle"));
      const tree = await SafeOutputTree.create(output);
      const originalStat = handlePrototype.stat;
      const stat = vi.spyOn(handlePrototype, "stat");
      stat
        .mockImplementationOnce(function (
          this: typeof prototypeHandle,
          ...args
        ) {
          return originalStat.apply(this, args);
        })
        .mockRejectedValueOnce(new Error("injected file identity failure"));

      await expect(
        tree.write("payload.txt", Readable.from(Buffer.from("owned")), {
          sha256: createHash("sha256").update("owned").digest("hex"),
          bytes: Buffer.byteLength("owned"),
        }),
      ).rejects.toThrow("injected file identity failure");
      stat.mockRestore();
      await rename(destination, displaced);
      await symlink(outside, destination, "file");

      const failure = await tree.rollback().catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(await readlink(destination)).toBe(outside);
      expect(await readFile(outside, "utf8")).toBe("outside bytes");

      await rm(destination);
      await rename(displaced, destination);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      expect(await readdir(parent)).toEqual(["outside.txt"]);
    },
  );
});

describe("safe artifact output setup ownership", () => {
  it.skipIf(process.platform === "win32")(
    "returns its exact tree owner when setup fails after root identity capture",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-setup-");
      const output = join(parent, "published");
      const blocker = join(output, "unowned.txt");
      const prototypeHandle = await open(join(parent, "handle"), "w");
      const handlePrototype = Object.getPrototypeOf(prototypeHandle) as Pick<
        typeof prototypeHandle,
        "chmod"
      >;
      await prototypeHandle.close();
      await rm(join(parent, "handle"));
      const chmodSpy = vi
        .spyOn(handlePrototype, "chmod")
        .mockImplementationOnce(async function (this: typeof prototypeHandle) {
          await writeFile(blocker, "leave until cleanup retry");
          throw new Error("injected setup failure");
        });

      const failure = await SafeOutputTree.create(output).catch(
        (cause: unknown) => cause,
      );
      chmodSpy.mockRestore();
      expect(failure).toBeInstanceOf(SafeOutputTreeCreationFailure);
      if (!(failure instanceof SafeOutputTreeCreationFailure))
        throw new Error("expected setup failure to retain its tree owner");
      expect(failure.cause).toMatchObject({
        message: "injected setup failure",
      });
      expect(failure.tree.outputRoot).toBe(output);

      const cleanupFailure = await failure.tree
        .rollback()
        .catch((cause: unknown) => cause);
      expect(cleanupFailure).toBeInstanceOf(ArtifactReaderFailure);
      expect(await readFile(blocker, "utf8")).toBe("leave until cleanup retry");
      await rm(blocker);
      expect(await failure.tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      expect(await readdir(parent)).toEqual([]);
    },
  );
});

describe("safe artifact output tree identity", () => {
  it.skipIf(process.platform === "win32")(
    "refuses a replaced root and retries cleanup when the owned root is restored",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-root-");
      const output = join(parent, "published");
      const displaced = join(parent, "owned-original");
      const outside = join(parent, "outside");
      await mkdir(outside);
      const tree = await SafeOutputTree.create(output);
      await rename(output, displaced);
      await symlink(outside, output, "dir");

      const writeFailure = await tree
        .write("escaped.txt", Readable.from(Buffer.from("outside")), {
          sha256: createHash("sha256").update("outside").digest("hex"),
          bytes: Buffer.byteLength("outside"),
        })
        .catch((cause: unknown) => cause);
      expect(writeFailure).toBeInstanceOf(ArtifactReaderFailure);
      await expect(access(join(outside, "escaped.txt"))).rejects.toThrow();
      await expect(tree.commit()).rejects.toBeInstanceOf(ArtifactReaderFailure);
      const cleanupFailure = await tree
        .rollback()
        .catch((cause: unknown) => cause);
      expect(cleanupFailure).toBeInstanceOf(ArtifactReaderFailure);
      expect(cleanupFailure).toMatchObject({
        cleanup: { resources: [output] },
      });
      expect(await readlink(output)).toBe(outside);

      await rm(output);
      await rename(displaced, output);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      expect(await readdir(parent)).toEqual(["outside"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a replaced nested parent without touching it and retries after restoration",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-parent-");
      const output = join(parent, "published");
      const nested = join(output, "nested");
      const displaced = join(parent, "owned-nested");
      const outside = join(parent, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "sentinel.txt"), "keep");
      const tree = await SafeOutputTree.create(output);
      const bytes = Buffer.from("owned");
      await tree.write("nested/owned.txt", Readable.from(bytes), {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
      await rename(nested, displaced);
      await symlink(outside, nested, "dir");

      const writeFailure = await tree
        .write("nested/escaped.txt", Readable.from(Buffer.from("outside")), {
          sha256: createHash("sha256").update("outside").digest("hex"),
          bytes: Buffer.byteLength("outside"),
        })
        .catch((cause: unknown) => cause);
      expect(writeFailure).toBeInstanceOf(ArtifactReaderFailure);
      await expect(access(join(outside, "escaped.txt"))).rejects.toThrow();
      expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe(
        "keep",
      );
      const cleanupFailure = await tree
        .rollback()
        .catch((cause: unknown) => cause);
      expect(cleanupFailure).toBeInstanceOf(ArtifactReaderFailure);
      expect(await readlink(nested)).toBe(outside);
      expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe(
        "keep",
      );

      await rm(nested);
      await rename(displaced, nested);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      expect(await readdir(parent)).toEqual(["outside"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves an outside file when a tracked output file is replaced by a symlink",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-file-");
      const output = join(parent, "published");
      const tracked = join(output, "nested", "file.txt");
      const displaced = join(parent, "owned-file.txt");
      const outside = join(parent, "outside.txt");
      await writeFile(outside, "outside bytes");
      const tree = await SafeOutputTree.create(output);
      const bytes = Buffer.from("owned bytes");
      await tree.write("nested/file.txt", Readable.from(bytes), {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
      await rename(tracked, displaced);
      await symlink(outside, tracked, "file");

      const failure = await tree.rollback().catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      expect(tree.cleanup).toMatchObject({ status: "incomplete" });
      expect(await readlink(tracked)).toBe(outside);
      expect(await readFile(outside, "utf8")).toBe("outside bytes");

      await rm(tracked);
      await rename(displaced, tracked);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      expect(await readFile(outside, "utf8")).toBe("outside bytes");
    },
  );
});

it("retains an untracked regular entry and retries after it is removed", async () => {
  const parent = await createTestTempDirectory("rea-safe-output-untracked-");
  const output = join(parent, "published");
  const untracked = join(output, "untracked.txt");
  const tree = await SafeOutputTree.create(output);
  const bytes = Buffer.from("owned bytes");
  await tree.write("owned.txt", Readable.from(bytes), {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  });
  await writeFile(untracked, "leave untouched");

  const failure = await tree.rollback().catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(tree.cleanup).toMatchObject({ status: "incomplete" });
  expect(await readdir(output)).toEqual(["untracked.txt"]);
  expect(await readFile(untracked, "utf8")).toBe("leave untouched");

  await rm(untracked);
  expect(await tree.rollback()).toEqual({
    status: "complete",
    residualPaths: [],
  });
  expect(await readdir(parent)).toEqual([]);
});
describe("safe artifact output tree", () => {
  it("removes only its owned tree after digest failure and proves absence", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);
    await expect(
      tree.write("nested/file.txt", Readable.from(Buffer.from("unexpected")), {
        sha256: "0".repeat(64),
        bytes: Buffer.byteLength("unexpected"),
      }),
    ).rejects.toThrow(/disagrees/u);
    expect(await tree.rollback()).toMatchObject({
      status: "complete",
      residualPaths: [],
    });
    await expect(access(output)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports the owned residual root when rollback lacks directory permissions",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-rollback-");
      const output = join(parent, "published");
      const tree = await SafeOutputTree.create(output);
      const bytes = Buffer.from("retained until rollback can retry");
      await tree.write("nested/file.txt", Readable.from(bytes), {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
      try {
        await chmod(output, 0o500);
        const failure = await tree.rollback().catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({
          cause: { code: "EACCES" },
          cleanup: { resources: [output] },
        });
      } finally {
        await chmod(output, 0o700).catch(() => undefined);
        await tree.rollback();
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retains cleanup progress when one owned sibling is not writable",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-siblings-");
      const output = join(parent, "published");
      const completed = join(output, "completed");
      const blocked = join(output, "blocked");
      const tree = await SafeOutputTree.create(output);
      for (const directory of ["completed", "blocked"]) {
        const bytes = Buffer.from(join(output, directory));
        await tree.write(`${directory}/file.txt`, Readable.from(bytes), {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        });
      }

      try {
        await chmod(blocked, 0o500);
        const failure = await tree.rollback().catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({
          cause: { code: "EACCES" },
          cleanup: { resources: [output] },
        });
        expect(await readdir(output)).toEqual(["blocked"]);
        await expect(access(completed)).rejects.toThrow();
        expect(await readFile(join(blocked, "file.txt"), "utf8")).toBe(blocked);
        await expect(
          tree.write("new/file.txt", Readable.from(Buffer.from("late")), {
            sha256: createHash("sha256").update("late").digest("hex"),
            bytes: Buffer.byteLength("late"),
          }),
        ).rejects.toBeInstanceOf(ArtifactReaderFailure);
        await expect(tree.commit()).rejects.toBeInstanceOf(
          ArtifactReaderFailure,
        );
      } finally {
        await chmod(blocked, 0o700);
      }

      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      expect(await readdir(parent)).toEqual([]);
    },
  );

  it("publishes files while building and preserves them after sealing", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);
    const bytes = Buffer.from("visible before seal");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await tree.write("file.txt", Readable.from(bytes), {
      sha256: digest,
      bytes: bytes.byteLength,
    });
    expect(await readFile(join(output, "file.txt"), "utf8")).toBe(
      "visible before seal",
    );

    await tree.commit();
    expect(await tree.rollback()).toEqual({ status: "not-required" });
    expect(await readFile(join(output, "file.txt"), "utf8")).toBe(
      "visible before seal",
    );
  });

  it("returns detached cleanup reports", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const tree = await SafeOutputTree.create(join(parent, "published"));
    const cleanup = await tree.rollback();
    if (cleanup.status !== "complete") throw new Error("expected cleanup");
    (cleanup.residualPaths as unknown as string[]).push("/forged/path");

    expect(tree.cleanup).toEqual({ status: "complete", residualPaths: [] });
    expect(await tree.rollback()).toEqual({
      status: "complete",
      residualPaths: [],
    });
    await expect(
      tree.write("late.txt", Readable.from(Buffer.from("late")), {
        sha256: createHash("sha256").update("late").digest("hex"),
        bytes: Buffer.byteLength("late"),
      }),
    ).rejects.toBeInstanceOf(ArtifactReaderFailure);
    await expect(tree.commit()).rejects.toBeInstanceOf(ArtifactReaderFailure);
  });

  it("publishes without POSIX-only directory chmod or fsync on Windows", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output, "win32");
    const bytes = Buffer.from("windows output");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await tree.write("nested/file.txt", Readable.from(bytes), {
      sha256: digest,
      bytes: bytes.byteLength,
    });
    await tree.commit();
    expect(await readFile(join(output, "nested", "file.txt"), "utf8")).toBe(
      "windows output",
    );
  });
});

describe("safe artifact output Windows stream paths", () => {
  it.each([
    "hello.txt:hidden",
    "nested/hello.txt::$DATA",
    "folder:stream/file.txt",
  ])("refuses Windows stream syntax before creating %s", async (path) => {
    const parent = await createTestTempDirectory("rea-safe-output-stream-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output, "win32");
    const bytes = Buffer.from("regular file content");
    const source = Readable.from(bytes);
    try {
      await expect(
        tree.write(path, source, {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        }),
      ).rejects.toMatchObject({
        reason: "path",
        message: `Windows destination cannot materialize artifact path as a regular file: ${path}; ':' denotes alternate data stream syntax.`,
      });
      expect(source.destroyed).toBe(true);
      expect(await readdir(output)).toEqual([]);
    } finally {
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(parent)).toEqual([]);
  });

  it.each(["Folder/Icon\r", "Fold\ter/file.txt"])(
    "refuses Windows control characters before creating %j",
    async (path) => {
      const parent = await createTestTempDirectory("rea-safe-output-control-");
      const output = join(parent, "published");
      const tree = await SafeOutputTree.create(output, "win32");
      const bytes = Buffer.from("regular file content");
      await expect(
        tree.write(path, Readable.from(bytes), {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        }),
      ).rejects.toMatchObject({
        reason: "path",
        message: `Windows destination cannot materialize artifact path: ${JSON.stringify(path)}; Windows names cannot contain U+0001-U+001F.`,
      });
      expect(await readdir(output)).toEqual([]);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    },
  );
});

describe("safe artifact output sources without close events", () => {
  it.each([false, true])(
    "returns a destination refusal after silent destruction (deferred: %s)",
    async (deferred) => {
      const parent = await createTestTempDirectory("rea-output-silent-close-");
      const output = join(parent, "output");
      const tree = await SafeOutputTree.create(output);
      let completeDestroy!: () => void;
      let destroying!: () => void;
      const destructionStarted = new Promise<void>((resolve) => {
        destroying = resolve;
      });
      const source = new Readable({
        emitClose: false,
        read() {
          throw new Error("refused destination must not consume input");
        },
        destroy(_error, callback) {
          completeDestroy = () => callback(null);
          if (!deferred) completeDestroy();
          destroying();
        },
      });
      let settled = false;
      const pending = tree
        .write("../outside", source, { bytes: 0, sha256: "" })
        .catch((cause: unknown) => cause)
        .finally(() => {
          settled = true;
        });
      try {
        await destructionStarted;
        if (deferred) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(source.closed).toBe(false);
          completeDestroy();
        }
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(await pending).toMatchObject({ reason: "path" });
        expect(source.closed).toBe(true);
        expect(source.listenerCount("error")).toBe(0);
        expect(source.listenerCount("end")).toBe(0);
        expect(source.listenerCount("close")).toBe(0);
      } finally {
        if (!source.closed) completeDestroy();
        expect(await tree.rollback()).toEqual({
          status: "complete",
          residualPaths: [],
        });
      }
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([false, true])(
    "preserves a silent source outcome (read failure: %s)",
    async (failRead) => {
      const parent = await createTestTempDirectory("rea-output-silent-read-");
      const output = join(parent, "output");
      const tree = await SafeOutputTree.create(output);
      const failure = new Error("source read failed");
      const source = new Readable({
        emitClose: false,
        read() {
          this.push(Buffer.from("owned"));
          if (failRead) this.destroy(failure);
          else this.push(null);
        },
      });
      try {
        const pending = tree.write("file", source, {
          bytes: 5,
          sha256: createHash("sha256").update("owned").digest("hex"),
        });
        if (failRead) await expect(pending).rejects.toBe(failure);
        else {
          await expect(pending).resolves.toMatchObject({ bytesWritten: 5 });
          expect(await readFile(join(output, "file"), "utf8")).toBe("owned");
        }
        expect(source.closed).toBe(true);
      } finally {
        expect(await tree.rollback()).toEqual({
          status: "complete",
          residualPaths: [],
        });
      }
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("safe artifact output source lifetime", () => {
  it("consumes only the readable side of a duplex source", async () => {
    const parent = await createTestTempDirectory("rea-output-duplex-");
    const output = join(parent, "output");
    const tree = await SafeOutputTree.create(output);
    const source = new Duplex({
      allowHalfOpen: true,
      read() {
        this.push(Buffer.from("owned"));
        this.push(null);
      },
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    try {
      await expect(
        tree.write("file", source, {
          bytes: 5,
          sha256: createHash("sha256").update("owned").digest("hex"),
        }),
      ).resolves.toMatchObject({ bytesWritten: 5 });
      expect(source.writableEnded).toBe(false);
      expect(await readFile(join(output, "file"), "utf8")).toBe("owned");
    } finally {
      source.destroy();
      await tree.rollback();
    }
  });
  it.each([false, true])(
    "preserves cancellation before source consumption (already aborted: %s)",
    async (alreadyAborted) => {
      const parent = await createTestTempDirectory("rea-output-source-");
      const input = join(parent, "input");
      const output = join(parent, "output");
      await writeFile(input, "owned");
      const handle = await open(input, "r");
      const tree = await SafeOutputTree.create(output);
      const controller = new AbortController();
      const reason = new DOMException("publication deadline", "TimeoutError");
      if (alreadyAborted) controller.abort(reason);
      const source = readArtifactFileChunks(handle, {
        signal: controller.signal,
      });
      try {
        const pending = tree.write(
          "nested/file",
          source,
          {
            bytes: 5,
            sha256: createHash("sha256").update("owned").digest("hex"),
          },
          controller.signal,
        );
        if (!alreadyAborted) controller.abort(reason);
        await expect(pending).rejects.toMatchObject({
          reason: "cancelled",
          cause: reason,
        });
        expect(source.closed).toBe(true);
        expect(source.readCoverage()).toEqual({
          kind: "incomplete",
          bytes: 0n,
        });
        expect(await tree.rollback()).toEqual({
          status: "complete",
          residualPaths: [],
        });
        await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await tree.rollback();
        await handle.close();
      }
    },
  );

  it.each([false, true])(
    "settles an unread source before returning a destination refusal (early error: %s)",
    async (earlyError) => {
      const parent = await createTestTempDirectory("rea-output-refusal-");
      const tree = await SafeOutputTree.create(join(parent, "output"));
      let completeDestroy!: () => void;
      let destroying!: () => void;
      const destructionStarted = new Promise<void>((resolve) => {
        destroying = resolve;
      });
      const source = new Readable({
        read() {
          throw new Error("refused destination must not consume input");
        },
        destroy(_error, callback) {
          completeDestroy = () => callback(new Error("source cleanup failure"));
          destroying();
        },
      });
      let settled = false;
      const pending = tree
        .write("../outside", source, { bytes: 0, sha256: "" })
        .catch((cause: unknown) => cause)
        .finally(() => {
          settled = true;
        });
      try {
        await destructionStarted;
        if (earlyError) source.emit("error", new Error("early source failure"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
      } finally {
        completeDestroy();
        const failure = await pending;
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({ reason: "path" });
        const sourceFailures = (failure as SafeOutputSourceFailure)
          .sourceFailures;
        expect(sourceFailures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: "source cleanup failure" }),
          ]),
        );
        if (earlyError)
          expect(sourceFailures).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ message: "early source failure" }),
            ]),
          );
        expect((failure as ArtifactReaderFailure).cleanup).toBeUndefined();
        expect(source.closed).toBe(true);
        await tree.rollback();
      }
    },
  );
});
