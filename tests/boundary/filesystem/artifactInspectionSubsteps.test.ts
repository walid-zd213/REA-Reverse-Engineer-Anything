import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createArtifactInspection } from "../../../src/domain/artifactInspection.js";
import { compareArtifacts } from "../../../src/domain/artifactComparison.js";
import { parseArtifactInventoryEvidence } from "../../../src/domain/artifactInventoryEvidence.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { fragmentInventoryEvidence } from "../../fixtures/artifactEvidence.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const PROVIDER = {
  id: "rea-artifact-graph",
  name: "REA artifact graph",
  version: "1",
} as const;

it("merges every inventory substep from inspect_artifact Evidence", async () => {
  const root = await createTestTempDirectory("rea-artifact-substeps-");
  const target = join(root, "fixture.app");
  await mkdir(target);
  await writeFile(join(target, "main.js"), "main();");

  const inventory = await inventoryArtifact(target);
  const source = createEvidence(
    {
      path: target,
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    PROVIDER,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: jsonValueSchema.parse(inventory),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
  const [first, second] = fragmentInventoryEvidence(source, 2);
  if (first === undefined || second === undefined)
    throw new Error("Missing inventory fragment");

  const inspection = createArtifactInspection(first);
  const firstSubstep = inspection.substeps[0];
  if (firstSubstep === undefined) throw new Error("Missing inspection substep");
  const parent = createEvidence(
    {
      path: target,
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    PROVIDER,
    {
      operation: "inspect_artifact",
      parameters: {},
      result: jsonValueSchema.parse({
        ...inspection,
        substeps: [
          firstSubstep,
          {
            ...firstSubstep,
            substep_id: `ais_${"0".repeat(64)}`,
            evidence_id: second.evidence_id,
            evidence: second,
          },
        ],
        coverage: {
          ...inspection.coverage,
          substeps_completed: 2,
        },
        evidence_links: [first.evidence_id, second.evidence_id],
      }),
      confidence: "derived",
      authority: "shipped-artifact",
    },
  );

  const parsed = parseArtifactInventoryEvidence(parent);
  expect(parsed.evidence.map(({ evidence_id }) => evidence_id)).toEqual([
    parent.evidence_id,
  ]);
  expect(parsed.inventory.complete).toBe(true);
  expect(parsed.inventory.nodes).toHaveLength(inventory.manifest.node_count);
  expect(parsed.inventory.occurrences).toHaveLength(
    inventory.manifest.occurrence_count,
  );
  expect(parsed.inventory.edges).toHaveLength(inventory.manifest.edge_count);
  expect(compareArtifacts(parent, parent)).toMatchObject({
    status: "unchanged",
    summary: { unknown: 0 },
  });
});
