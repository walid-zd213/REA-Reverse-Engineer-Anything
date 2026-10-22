import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBinaryNinjaTarget,
  RecordingBinaryNinjaMcp,
} from "../../tests/fixtures/binaryNinjaMcp.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { BinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";
import { BINARY_NINJA_XREF_LIMITATION } from "./BinaryNinjaProviderCapabilities.js";
import { BinaryNinjaSessionClient } from "./BinaryNinjaSessionClient.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const config: BinaryNinjaConfiguration = {
  url: "http://127.0.0.1:24642/mcp",
  headers: {},
  timeoutMs: 1000,
  maxInputBytes: 1024 * 1024,
};

const fixture = async (settings: Partial<BinaryNinjaConfiguration> = {}) => {
  const { root, target, bytes } = await createBinaryNinjaTarget();
  roots.push(root);
  const producer = new RecordingBinaryNinjaMcp(target, bytes);
  const client = new BinaryNinjaSessionClient(
    { ...config, ...settings },
    target,
    producer,
  );
  return { target, producer, client };
};

const value = async (
  client: BinaryNinjaSessionClient,
  operation: Parameters<BinaryNinjaSessionClient["execute"]>[0],
  parameters: Parameters<BinaryNinjaSessionClient["execute"]>[1] = {},
) => {
  const result = await client.execute(operation, parameters);
  if (!result.ok) throw result.error;
  return result.value;
};

describe("Binary Ninja target binding", () => {
  it("binds the open file by its Raw view digest and never calls mutation tools", async () => {
    const { client, producer } = await fixture();
    const execution = await value(client, "procedure_address", {
      procedure: "main",
    });
    expect(execution.result).toBe("0x401000");
    const called = new Set(producer.calls.map(({ name }) => name));
    for (const name of called)
      expect(name).toMatch(
        /^bn_(open_item_list|binary_view_(list|get_active|set_active)|analysis_status|memory_read|function_(list|search|info))$/u,
      );
    expect(
      producer.calls.filter(
        ({ name, args }) => name === "bn_memory_read" && args.address === "0x0",
      ),
    ).toHaveLength(2);
    expect(producer.active).toBe("view_1");
  });

  it("refuses a file whose loaded bytes differ from the selected target", async () => {
    const { client, producer } = await fixture();
    producer.rawBytes = Buffer.from(producer.rawBytes).fill(0, 0, 4);
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProviderAdapterError);
    expect(result.error.diagnostics).toMatchObject({
      reason: "target_digest_mismatch",
    });
    // The shared selection is never left on the Raw view REA chose for hashing.
    expect(producer.active).toBe("view_1");
  });

  it("rejects bytes patched after the first successful request", async () => {
    const { client, producer } = await fixture();
    await value(client, "list_procedures");
    producer.rawBytes = Buffer.from(producer.rawBytes).fill(0, 0, 4);
    const callsBefore = producer.calls.length;
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.diagnostics).toMatchObject({
        reason: "target_digest_mismatch",
      });
    expect(
      producer.calls.slice(callsBefore).map(({ name }) => name),
    ).not.toContain("bn_function_list");
    expect(producer.active).toBe("view_1");
    expect((await client.close()).ok).toBe(true);
  });

  it("rejects bytes patched during a request and retains only partial evidence", async () => {
    const { client, producer } = await fixture();
    producer.beforeCall = (name) => {
      if (name === "bn_function_list")
        producer.rawBytes = Buffer.from(producer.rawBytes).fill(0, 0, 4);
    };
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.diagnostics).toMatchObject({
        reason: "target_digest_mismatch",
      });
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: { target_binding: { status: "not_verified" } },
      });
    }
    expect(producer.active).toBe("view_1");
    expect((await client.close()).ok).toBe(true);
  });

  it("restores the analysis view when cancellation arrives with the final Raw read", async () => {
    const { client, producer } = await fixture();
    await value(client, "list_procedures");
    const controller = new AbortController();
    producer.beforeCall = (name) => {
      if (name === "bn_memory_read") controller.abort("cancel identity check");
    };
    const result = await client.execute(
      "list_procedures",
      {},
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(producer.active).toBe("view_1");
    expect((await client.close()).ok).toBe(true);
  });
});

describe("Binary Ninja startup and lifecycle", () => {
  it.each(["stalled", "changing total"])(
    "rejects %s startup pages and allows cleanup",
    async (mode) => {
      const { client, producer } = await fixture();
      producer.pageSize = 1;
      let pages = 0;
      producer.beforeCall = (name) => {
        if (name !== "bn_binary_view_list") return;
        pages++;
        if (pages > 2) throw new Error("Fixture stopped a repeated page");
        if (pages === 2) {
          if (mode === "stalled") producer.pageSize = 0;
          else producer.views.pop();
        }
      };
      const result = await client.execute("list_procedures", {});
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toContain(
          mode === "stalled" ? "did not advance" : "changed its total",
        );
      expect(pages).toBe(2);
      expect((await client.close()).ok).toBe(true);
      expect(producer.closes).toBe(1);
    },
  );

  it("names the target when it is not open and retries after it opens", async () => {
    const { client, producer } = await fixture();
    const path = producer.openPath;
    producer.openPath = "/elsewhere/other.elf";
    const first = await client.execute("list_procedures", {});
    expect(first.ok).toBe(false);
    if (!first.ok)
      expect(first.error.diagnostics).toMatchObject({
        reason: "target_not_open",
      });
    producer.openPath = path;
    expect((await value(client, "list_procedures")).result).toHaveLength(2);
  });

  it("reports missing built-in tools before reading any target data", async () => {
    const { client, producer } = await fixture();
    producer.tools = producer.tools.filter(
      (name) => name !== "bn_function_decompile",
    );
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.diagnostics).toMatchObject({
      missing_tools: ["bn_function_decompile"],
    });
    expect(producer.calls).toHaveLength(0);
  });

  it("bounds identity hashing by maxInputBytes", async () => {
    const { client } = await fixture({ maxInputBytes: 8 });
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  });

  it("requires settled analysis", async () => {
    const { client, producer } = await fixture();
    producer.analysisState = "AnalyzeState";
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("still running");
  });

  it("re-selects its view after another client switches it, and rejects a switch during a request", async () => {
    const { client, producer } = await fixture();
    await value(client, "list_procedures");
    producer.active = "view_2";
    expect((await value(client, "list_procedures")).result).toHaveLength(2);
    producer.beforeCall = (name) => {
      if (name === "bn_function_list") producer.active = "view_2";
    };
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisProtocolError);
  });

  it("restores the previous shared selection on close", async () => {
    const { client, producer } = await fixture();
    producer.active = "view_2";
    await value(client, "list_procedures");
    expect(producer.active).toBe("view_1");
    expect((await client.close()).ok).toBe(true);
    expect(producer.active).toBe("view_2");
    expect(producer.closes).toBe(1);
  });
});

describe("Binary Ninja operations", () => {
  it("drains every page and rejects a total that changes while paging", async () => {
    const { client, producer } = await fixture();
    producer.pageSize = 1;
    expect((await value(client, "list_procedures")).result).toEqual([
      { address: "0x401000", value: "main" },
      { address: "0x401100", value: "helper, with (parens)" },
    ]);
    let pages = 0;
    producer.beforeCall = (name) => {
      if (name === "bn_function_list" && ++pages === 2)
        producer.functions = [...producer.functions, ...producer.functions];
    };
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("total");
  });

  it("matches names exactly instead of evaluating them as expressions", async () => {
    const { client, producer } = await fixture();
    expect(
      (
        await value(client, "procedure_address", {
          procedure: "helper, with (parens)",
        })
      ).result,
    ).toBe("0x401100");
    expect(
      producer.calls.some(
        ({ name, args }) =>
          name === "bn_function_info" &&
          args.function === "helper, with (parens)",
      ),
    ).toBe(false);
    const missing = await client.execute("procedure_address", {
      procedure: "main+4",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBeInstanceOf(AnalysisInputError);
      expect(missing.error.partialObservation).toBeUndefined();
    }
  });

  it("reports a non-entry address as invalid caller input", async () => {
    const { client } = await fixture();
    const result = await client.execute("procedure_pseudo_code", {
      procedure: "0x401001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  });

  it("returns rendered pseudocode and normalized instruction lines", async () => {
    const { client } = await fixture();
    expect(
      (await value(client, "procedure_pseudo_code", { procedure: "main" }))
        .result,
    ).toBe("  int32_t main()\n\n{\n    return helper(1);\n}");
    expect(
      (await value(client, "procedure_assembly", { procedure: "0x401000" }))
        .result,
    ).toBe(
      "0x401000: push    rbp\n0x401001: call    helper\n0x401006: ret     ",
    );
  });
});

describe("Binary Ninja relationships, strings and dossiers", () => {
  it("resolves callers, callees and import slots through their symbols", async () => {
    const { client } = await fixture();
    const callees = await value(client, "procedure_callees", {
      procedure: "0x401100",
    });
    expect(callees.result).toEqual(["0x403000"]);
    expect(callees.relationshipCoverage).toEqual({ status: "complete" });
    const callers = await value(client, "procedure_callers", {
      procedure: "0x401100",
    });
    expect(callers.result).toEqual(["0x401000"]);
  });

  it("marks callees without a function or symbol as partial coverage", async () => {
    const { client, producer } = await fixture();
    producer.symbols.clear();
    const callees = await value(client, "procedure_callees", {
      procedure: "0x401100",
    });
    expect(callees.result).toEqual([]);
    expect(callees.relationshipCoverage?.status).toBe("partial");
  });

  it("combines data references with direct call sites and never claims completeness", async () => {
    const { client } = await fixture();
    const xrefs = await value(client, "xrefs", { address: "0x401100" });
    expect([...(xrefs.result as string[])].sort()).toEqual([
      "0x401001",
      "0x402100",
    ]);
    expect(xrefs.referencesTruncated).toBe(true);
    expect(xrefs.limitations).toContain(BINARY_NINJA_XREF_LIMITATION);
    const data = await value(client, "xrefs", { address: "0x402000" });
    expect(data.result).toEqual([]);
    expect(data.referencesTruncated).toBe(true);
  });

  it("decodes string bytes by type and reads previews Binary Ninja truncated", async () => {
    const { client, producer } = await fixture();
    expect((await value(client, "list_strings")).result).toEqual([
      { address: "0x402000", value: "a|b" },
      { address: "0x402010", value: "wide" },
      { address: "0x402200", value: "L".repeat(300) },
    ]);
    expect(
      producer.calls.some(
        ({ name, args }) =>
          name === "bn_memory_read" && args.address === "0x402200",
      ),
    ).toBe(true);
    expect(
      (await value(client, "search_strings", { pattern: "WIDE" })).result,
    ).toEqual([{ address: "0x402010", value: "wide" }]);
  });

  it("omits multi-byte strings when the view's byte order is unknown", async () => {
    const { client, producer } = await fixture();
    const view = producer.views[0];
    if (view !== undefined) view.architecture = "ppc";
    const strings = await value(client, "list_strings");
    expect(strings.result).toEqual([
      { address: "0x402000", value: "a|b" },
      { address: "0x402200", value: "L".repeat(300) },
    ]);
    expect(strings.limitations.join("\n")).toContain("Utf16String");
  });

  it("builds a function dossier with explicit unavailable facets", async () => {
    const { client } = await fixture();
    const dossier = (
      await value(client, "analyze_function", {
        procedure: "main",
      })
    ).result as Record<string, unknown>;
    expect(dossier).toMatchObject({
      procedure: {
        address: "0x401000",
        name: "main",
        signature: "int32_t main()",
      },
      callees: [{ address: "0x401100", name: "helper, with (parens)" }],
      facet_availability: {
        cfg: { available: false },
        references: { available: false },
      },
    });
  });

  it("lists only the admitted document and rejects others", async () => {
    const { client, target } = await fixture();
    expect((await value(client, "list_documents")).result).toEqual([
      target.path,
    ]);
    const other = await client.execute("list_procedures", {
      document: "/elsewhere/other.elf",
    });
    expect(other.ok).toBe(false);
  });

  it("rejects operations outside the read-only profile", async () => {
    const { client, producer } = await fixture();
    const result = await client.execute("set_comment", {});
    expect(result.ok).toBe(false);
    expect(producer.calls).toHaveLength(0);
  });
});
