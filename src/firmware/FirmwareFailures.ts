import {
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
} from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { SafeOutputSourceFailure } from "../artifacts/SafeOutputSourceFailure.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { FirmwareDeadline } from "./FirmwareDeadline.js";
import { firmwareDeadlineElapsed } from "./FirmwareDeadline.js";
import { z } from "zod";
import { MAX_FIRMWARE_TIMEOUT_MS } from "../domain/firmware/firmwareAnalysis.js";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";

/** Fixed firmware allowance. analysis_timeout_ms does not raise it. */
export const firmwareLimitRecovery = (allowance: string): string =>
  `${allowance}. This release has no runtime override. analysis_timeout_ms (--analysis-timeout-ms in the CLI) does not raise it. Repeating the unchanged request fails the same way.`;

/** Classify a prlimit signal that is not the analysis wall clock. */
export const firmwareSignalLimitError = (
  operation: string,
  signal: NodeJS.Signals | null | undefined,
  fileSizeBytes: number,
  fileSizeAdjustable: boolean,
  capturedOutput?: AnalysisCapturedOutput,
): AnalysisResourceConstraintError | undefined => {
  const recovery = (
    remediationAction: string,
  ): AnalysisResourceConstraintError =>
    new AnalysisResourceConstraintError(
      operation,
      signal === "SIGXCPU" ? "cpu" : "file-size",
      signal === "SIGXCPU"
        ? `Firmware analysis reached its ${String(FIRMWARE_LIMITS.cpuSeconds)}-second CPU allowance (cpuSeconds).`
        : `Firmware analysis reached its ${String(fileSizeBytes)}-byte file-size allowance.`,
      signal === "SIGXCPU"
        ? { cpu_seconds: FIRMWARE_LIMITS.cpuSeconds }
        : { file_size_bytes: fileSizeBytes },
      {
        retryable: false,
        remediationAction,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      },
    );
  if (signal === "SIGXCPU")
    return recovery(
      firmwareLimitRecovery(
        `cpuSeconds is ${String(FIRMWARE_LIMITS.cpuSeconds)}`,
      ),
    );
  if (signal !== "SIGXFSZ") return undefined;
  return recovery(
    fileSizeAdjustable
      ? `The file-size cap for this extraction is max_output_bytes at ${String(fileSizeBytes)} bytes. analysis_timeout_ms does not raise it. Increase max_output_bytes when it is below its schema maximum and the larger staging budget is still required. Repeating the unchanged request fails the same way.`
      : firmwareLimitRecovery(
          `The firmware file-size allowance is ${String(fileSizeBytes)} bytes`,
        ),
  );
};

/** Address-space and CPU ceilings that a wall-clock change cannot raise. */
export const firmwareProcessLimitRecovery = (
  fileSizeBytes: number,
  fileSizeAdjustable: boolean,
): string =>
  `cpuSeconds is ${String(FIRMWARE_LIMITS.cpuSeconds)}. The address-space allowance is ${String(FIRMWARE_LIMITS.addressSpaceBytes)} bytes. This release has no runtime override for those per-process allowances, and analysis_timeout_ms does not raise them. ${
    fileSizeAdjustable
      ? `The file-size cap for this call is max_output_bytes at ${String(fileSizeBytes)} bytes. analysis_timeout_ms does not raise it.`
      : `The file-size allowance is ${String(fileSizeBytes)} bytes. This release has no runtime override for that allowance, and analysis_timeout_ms does not raise it.`
  }`;

type FirmwarePublicationProgress = {
  readonly output_directory: string;
  readonly verified_files: number;
  readonly total_files: number;
};

interface FirmwareFailureContext {
  readonly engine: string;
  readonly operation: string;
  readonly deadline?: FirmwareDeadline | undefined;
  readonly treeCleanupLease?: AnalysisCleanupLease | undefined;
  readonly publication?: FirmwarePublicationProgress | undefined;
}

const timeoutFailure = (
  operation: string,
  reason: unknown,
  deadline: FirmwareDeadline,
  options: Pick<AnalysisErrorOptions, "partialObservation"> & {
    readonly publication?: FirmwarePublicationProgress | undefined;
  } = {},
): AnalysisTimeoutError =>
  new AnalysisTimeoutError(operation, deadline.timeoutMs, {
    cause: reason,
    partialObservation: options.partialObservation,
    diagnostics: {
      phase: deadline.phase,
      ...(options.publication === undefined
        ? {}
        : { publication: options.publication }),
    },
    ...(deadline.phase === "publication"
      ? {
          userMessage: `Firmware publication exceeded its ${deadline.timeoutMs}ms budget. Extraction already completed.`,
          remediationAction:
            "Read any retained publication receipt first. For a retry, choose an absent local output directory or increase publication_timeout_ms (--publication-timeout-ms in the CLI).",
        }
      : {
          userMessage: `Firmware analysis exceeded its ${deadline.timeoutMs}ms wall-clock budget${operation === "extract_firmware" ? " before publication" : " during inspection or its final workspace cleanup"}.`,
          remediationAction: `Retry the same operation and preserve the selected input and analysis question. ${deadline.timeoutMs < MAX_FIRMWARE_TIMEOUT_MS ? `Increase analysis_timeout_ms (--analysis-timeout-ms in the CLI), an integer from 1 to ${MAX_FIRMWARE_TIMEOUT_MS} (default 120000).` : `analysis_timeout_ms (--analysis-timeout-ms in the CLI) is already at the maximum ${MAX_FIRMWARE_TIMEOUT_MS}; do not increase it further.`} Set the client tool-call timeout above the analysis budget plus publication and cleanup headroom. publication_timeout_ms only controls the later publication phase and cannot repair this analysis timeout. Fixed per-process CPU, memory and byte limits are unchanged. If cleanup is incomplete, resolve the reported owned resources before retrying; no server restart is needed after confirmed cleanup.`,
        }),
  });

/** Translate the producing file owner's outcome without guessing from a later signal. */
export const firmwareFailure = (
  cause: unknown,
  context: FirmwareFailureContext,
): AnalysisError => {
  if (cause instanceof SafeOutputSourceFailure) {
    // Source cleanup has its own authority, even when the producer cannot name
    // an exact lease. Output rollback cannot establish that it completed.
    const sourceContext = { ...context, treeCleanupLease: undefined };
    const primary = firmwareFailure(
      cause.cause,
      cause.primaryIsSource ? sourceContext : context,
    );
    const secondary = cause.sourceFailures.map((failure) =>
      firmwareFailure(failure, sourceContext),
    );
    const pending = secondary.filter((failure) => failure.cleanupIncomplete);
    let error = primary;
    if (pending.length > 0) {
      const cleanup = new ProviderCleanupError(
        context.engine,
        pending.flatMap((failure) => failure.cleanupResources),
        { reason: "Publication source cleanup remains incomplete" },
        { operation: context.operation, cause },
      ).bindCleanupDependencies(pending);
      error = analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        context.operation,
      ).bindCleanupDependencies([primary, cleanup]);
    }
    for (const failure of secondary) error.retainSecondaryFailure(failure);
    return error;
  }
  if (cause instanceof ArtifactFileCleanupFailure) {
    // The outer file owner covers only its own close. Inherited write/source
    // failures retain their independent owners through recursive translation.
    const physical = cause.fileCleanupFailure;
    const observation = ArtifactReaderFailure.cleanupObservation(
      physical.cleanupCause,
      physical.path,
    );
    const cleanup = new ProviderCleanupError(
      context.engine,
      observation.resources,
      { reason: observation.reason },
      { operation: context.operation, cause },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [cause.cleanupLease]);
    const primary =
      physical.outcome.kind === "failed"
        ? firmwareFailure(physical.outcome.cause, context)
        : physical.completionCancellation === undefined
          ? undefined
          : firmwareCancellation(
              context.operation,
              physical.completionCancellation.reason,
              context.deadline,
              context.publication,
            );
    return primary === undefined
      ? cleanup
      : analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          context.operation,
        ).bindCleanupDependencies([primary, cleanup]);
  }
  return classifyFirmwareFailure(cause, context);
};

const classifyFirmwareFailure = (
  cause: unknown,
  context: FirmwareFailureContext,
): AnalysisError => {
  const { engine, operation, deadline, treeCleanupLease, publication } =
    context;
  if (
    cause instanceof AnalysisCancelledError &&
    deadline?.signal.aborted &&
    cause.cause === deadline.signal.reason
  )
    return timeoutFailure(operation, cause.cause, deadline, {
      partialObservation: cause.partialObservation,
      publication,
    });
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const cleanup = new ProviderCleanupError(
      engine,
      cause.cleanup.resources,
      { reason: cause.cleanup.reason },
      { operation, cause },
    );
    bindArtifactFileCleanup(cause, cleanup);
    if (cause.cleanupLeases === undefined)
      treeCleanupLease?.bindCleanupError(cleanup);
    if (cause.reason === "cancelled")
      return analysisErrorWithCleanupFailure(
        firmwareCancellation(
          operation,
          artifactFileCancellationCause(cause),
          deadline,
          publication,
        ),
        cleanup,
        operation,
      ).bindCleanupDependencies([cleanup]);
    return cleanup;
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return firmwareCancellation(
      operation,
      artifactFileCancellationCause(cause),
      deadline,
      publication,
    );
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(
      operation,
      "Tool report violated the pinned producer protocol",
      { cause },
    );
  return new ProviderAdapterError(engine, operation, {
    cause,
    diagnostics: {
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

/** Classify the interruption actually observed, before composing cleanup failures. */
export const firmwareCancellation = (
  operation: string,
  reason: unknown,
  deadline?: FirmwareDeadline,
  publication?: FirmwarePublicationProgress,
): AnalysisError =>
  deadline?.signal.aborted && reason === deadline.signal.reason
    ? timeoutFailure(operation, reason, deadline, { publication })
    : new AnalysisCancelledError(operation, { cause: reason });

/** Preserve observed cancellation identity; otherwise enforce the monotonic budget. */
export const firmwarePhaseInterruption = (
  operation: string,
  signal: AbortSignal,
  deadline: FirmwareDeadline,
  publication?: FirmwarePublicationProgress,
): AnalysisError | undefined =>
  signal.aborted
    ? firmwareCancellation(operation, signal.reason, deadline, publication)
    : firmwareDeadlineElapsed(deadline)
      ? timeoutFailure(operation, undefined, deadline, { publication })
      : undefined;
