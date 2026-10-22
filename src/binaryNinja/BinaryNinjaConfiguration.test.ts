import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readBinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";

const roots: string[] = [];
const resourceScope: RetainedResourceScope = {
  run: (operation) => operation(),
  retain: () => {
    throw new Error("Unexpected retained descriptor");
  },
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-bn-registration-"));
  roots.push(root);
  const path = join(root, "mcp.json");
  const registration = JSON.stringify({ url: "http://127.0.0.1:24642/mcp" });
  await writeFile(path, registration);
  return { root, path, registration };
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("Binary Ninja registration ownership", () => {
  it("bounds the descriptor read and rejects non-regular inputs", async () => {
    const { root, path, registration } = await fixture();
    await writeFile(path, registration.padEnd(65_536));
    expect(
      (await readBinaryNinjaConfiguration(path, { resourceScope })).ok,
    ).toBe(true);
    await writeFile(path, registration.padEnd(65_537));
    expect(
      await readBinaryNinjaConfiguration(path, { resourceScope }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("64 KiB") },
    });
    expect(
      await readBinaryNinjaConfiguration(root, { resourceScope }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("regular JSON file") },
    });
  });

  it("preserves cancellation without starting the file read", async () => {
    const { path } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancel Binary Ninja registration");
    controller.abort(reason);
    await expect(
      readBinaryNinjaConfiguration(path, {
        resourceScope,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisCancelledError", cause: reason });
  });

  it("retains a denied descriptor close until its exact owner retries", async () => {
    const { path } = await fixture();
    const retained: { close(): Promise<void> }[] = [];
    const owner: RetainedResourceScope = {
      run: (operation) => operation(),
      retain: (resource) => retained.push(resource),
    };
    const close = OwnedFileHandle.prototype.close;
    let denied = false;
    vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
      this: OwnedFileHandle,
    ) {
      if (!denied) {
        denied = true;
        return Promise.reject(new Error("close denied"));
      }
      return close.call(this);
    });
    const result = await readBinaryNinjaConfiguration(path, {
      resourceScope: owner,
    });
    if (result.ok) throw new Error("Expected close failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(retained).toHaveLength(1);
    await rm(path);
    await retained[0]!.close();
    expect(result.error.cleanupIncomplete).toBe(false);
  });
});
