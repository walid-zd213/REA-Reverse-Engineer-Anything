import { snapshotEnvironment } from "../process/snapshotEnvironment.js";

import type { AppConfig } from "../config/types.js";
import { ok } from "../domain/result.js";
import { parseConfig } from "../config/parseConfig.js";
import { createBinarySession } from "../composition/binary.js";
import { createLogger } from "../logger.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./types.js";
import { openInitialTarget } from "./startup.js";
import { startMcpTransport } from "./transport.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "../composition/optionalObservationProviders.js";
import { createToolResultDelivery } from "../server/toolResult.js";
import { createShutdown } from "./shutdown.js";

/**
 * Start the long-lived MCP adapter and install idempotent shutdown handlers.
 * The adapter owns its BinarySession for the process lifetime; EOF and process
 * signals close bridge resources without assuming ownership of the Hopper app.
 */
export const runEager = async (
  dependencies: RuntimeDependencies,
  selectedConfig?: AppConfig,
): Promise<number> => {
  const environment = snapshotEnvironment(dependencies.env);
  const config =
    selectedConfig === undefined
      ? parseConfig(environment)
      : ok(selectedConfig);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const logger = createLogger("mcp", config.value.logLevel);
  const serverLogger = logger.child({ layer: "server" });
  const session = (dependencies.createSession ?? createBinarySession)(
    config.value,
    logger,
    environment,
  );
  // Handle signals before the initial open: provider children run detached,
  // so default signal termination would leave them behind. On stdio, stdin
  // EOF is seen only once the transport reads stdin, after startup.
  const lifecycle = createShutdown({ session, dependencies, serverLogger });
  try {
    const opened = await lifecycle.whileOpening(() =>
      openInitialTarget(session, config.value, {
        serverLogger,
        writeStderr: dependencies.writeStderr,
        signal: lifecycle.signal,
      }),
    );
    if (!opened.ok) {
      if ("cancelled" in opened) return lifecycle.finish();
      if (opened.cleanupPending) await lifecycle.finishFailedOpen();
      else await lifecycle.release();
      return opened.exitCode;
    }
    if (lifecycle.signal.aborted) return lifecycle.finish();
    const transport = await startMcpTransport(dependencies, session, {
      logger,
      serverLogger,
      environment,
      delivery: createToolResultDelivery(config.value.mcpMaxResponseBytes),
      loadOptionalProviders:
        dependencies.loadOptionalProviders ??
        (() =>
          loadOptionalObservationProviders(
            createOptionalObservationFactories(environment),
          )),
      signal: lifecycle.signal,
    });
    if (!transport.ok) {
      if ("cancelled" in transport) {
        lifecycle.attachTransport(transport);
        return lifecycle.finish();
      }
      await lifecycle.release();
      return 1;
    }
    lifecycle.attachTransport(transport);
    if (lifecycle.signal.aborted) return lifecycle.finish();
    // A deferred runtime owns process events and closes through this owner.
    dependencies.captureShutdown?.(lifecycle.shutdown);
    return 0;
  } catch (cause: unknown) {
    // An unexpected startup failure still closes what startup acquired.
    await lifecycle.finish();
    throw cause;
  }
};
