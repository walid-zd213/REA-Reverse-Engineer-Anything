import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Bob dry-run plan discloses REA_MCP_INPUT_SCHEMA_PROFILE=compact default",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-bob-plan-compact-");
    // Create the bob marker dir so the client is detected, but no mcp.json so
    // setup has a configure_client action to plan.
    await mkdir(join(home, ".bob"), { recursive: true });
    const environment = {
      HOME: home,
      USERPROFILE: home,
      HOPPER_LAUNCHER_PATH: join(home, "unconfigured-hopper"),
    };

    const planned = await cli.run({
      arguments: [
        "setup",
        "--client",
        "bob",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
      cwd: home,
      environment,
    });

    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      plannedActions: [
        expect.objectContaining({
          id: "configure_client:bob",
          detail: expect.stringContaining("REA_MCP_INPUT_SCHEMA_PROFILE=compact"),
        }),
      ],
      appliedActions: [],
    });
  },
);

cliTest(
  "Bob dry-run plan does not override an explicitly set REA_MCP_INPUT_SCHEMA_PROFILE",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-bob-plan-explicit-");
    // Create the bob marker dir so the client is detected.
    await mkdir(join(home, ".bob"), { recursive: true });
    const environment = {
      HOME: home,
      USERPROFILE: home,
      HOPPER_LAUNCHER_PATH: join(home, "unconfigured-hopper"),
      // Explicitly set to full via ambient provider env — the plan must
      // show this value and must NOT replace it with compact.
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
    };

    const planned = await cli.run({
      arguments: [
        "setup",
        "--client",
        "bob",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
      cwd: home,
      environment,
    });

    expect(planned.exitCode).toBe(0);
    expect(planned.json).toMatchObject({
      plannedActions: [
        expect.objectContaining({
          id: "configure_client:bob",
          detail: expect.stringContaining("REA_MCP_INPUT_SCHEMA_PROFILE=full"),
        }),
      ],
    });
    // Must not silently override an explicit setting.
    expect(JSON.stringify(planned.json)).not.toContain(
      "REA_MCP_INPUT_SCHEMA_PROFILE=compact",
    );
  },
);
