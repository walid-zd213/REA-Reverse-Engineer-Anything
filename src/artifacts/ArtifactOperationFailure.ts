import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { ArtifactResourceCleanupFailure } from "./ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { SafeOutputSourceFailure } from "./SafeOutputSourceFailure.js";
import { AnalysisCleanupLeaseGroup } from "./AnalysisCleanupLease.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "./ArtifactFileOperation.js";

/** Translate one artifact boundary failure while retaining cleanup evidence. */
export const translateArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError => {
  if (cause instanceof ArtifactResourceCleanupFailure)
    return translateResourceCleanupFailure(operation, cause);
  if (cause instanceof SafeOutputSourceFailure) {
    // Keep semantic classification with the primary, and cleanup with each
    // producing owner. Normalized wrapper metadata is only a snapshot.
    const primary = translateOwnedArtifactFailure(operation, cause.cause);
    const secondary = cause.sourceFailures.map((failure) =>
      translateOwnedArtifactFailure(operation, failure),
    );
    const pending = secondary.filter((failure) => failure.cleanupIncomplete);
    let error = primary;
    if (pending.length > 0) {
      const cleanup = new ArtifactOperationError(
        operation,
        "io",
        undefined,
        "Source cleanup remains incomplete",
        {
          cause,
          cleanup: {
            reason: "Source cleanup remains incomplete",
            resources: pending.flatMap((failure) => failure.cleanupResources),
          },
        },
      ).bindCleanupDependencies(pending);
      error = analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        operation,
      ).bindCleanupDependencies([primary, cleanup]);
    }
    for (const failure of secondary) error.retainSecondaryFailure(failure);
    return error;
  }
  if (cause instanceof ArtifactFileCleanupFailure) {
    // An outer close owns only its exact file, not the source's classification
    // or cleanup lifecycle. Preserve that primary through this boundary too.
    const physical = cause.fileCleanupFailure;
    const observation = ArtifactReaderFailure.cleanupObservation(
      physical.cleanupCause,
      physical.path,
    );
    const cleanup = new ArtifactOperationError(
      operation,
      "io",
      undefined,
      observation.reason,
      {
        cause: physical.cleanupCause,
        cleanup: observation,
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [cause.cleanupLease]);
    const primary =
      physical.outcome.kind === "failed"
        ? translateOwnedArtifactFailure(operation, physical.outcome.cause)
        : physical.completionCancellation === undefined
          ? undefined
          : translateArtifactFailure(
              operation,
              new ArtifactReaderFailure(
                "cancelled",
                "Artifact read cancelled during close",
                { cause: physical.completionCancellation.reason },
              ),
            );
    return primary === undefined
      ? cleanup
      : analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          operation,
        ).bindCleanupDependencies([primary, cleanup]);
  }
  if (cause instanceof ArtifactReaderFailure) {
    const error = new ArtifactOperationError(
      operation,
      cause.reason,
      cause.details,
      cause.message,
      {
        cause:
          cause.reason === "cancelled"
            ? artifactFileCancellationCause(cause)
            : cause,
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
        ...(cause.admission === undefined
          ? {}
          : { admission: cause.admission }),
      },
    );
    bindArtifactFileCleanup(cause, error);
    return error;
  }
  // Keep typed Evidence and other analysis failures instead of reducing them to I/O.
  if (cause instanceof AnalysisError) return cause;
  return new ArtifactOperationError(operation, "io");
};

/** A domain error already owns its live cleanup state; only classify raw errors. */
const translateOwnedArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : translateArtifactFailure(operation, ArtifactReaderFailure.from(cause));

/** Scope composition retains semantic fields separately from live owner state. */
const translateResourceCleanupFailure = (
  operation: ArtifactOperationError["operation"],
  cause: ArtifactResourceCleanupFailure,
): AnalysisError => {
  // These exact leases own only the failed scope cleanups. The independent
  // operation failure retains its original semantics and live dependencies.
  const owners = cause.failures.map(({ cause: failure, owner, lease }) => {
    const observation = ArtifactReaderFailure.cleanupObservation(
      failure,
      owner.resource,
    );
    const error = new ArtifactOperationError(
      operation,
      "io",
      undefined,
      observation.reason,
      {
        cause: failure,
        cleanup: observation,
      },
    );
    new AnalysisCleanupLeaseGroup(error, [lease]);
    return error;
  });
  // Without an operation failure, the scope projected the first cleanup
  // failure as the primary; keep its classification instead of reducing it to I/O.
  const completed = cause.outcome.kind === "completed";
  const cleanup = new ArtifactOperationError(
    operation,
    completed ? cause.reason : "io",
    completed ? cause.details : undefined,
    "Artifact resource cleanup remains incomplete",
    {
      cause: new AggregateError(owners, "Artifact resource cleanup failures"),
      cleanup: {
        reason: owners
          .map((owner) => owner.cleanup?.reason ?? owner.message)
          .join("; "),
        resources: owners.flatMap((owner) => owner.cleanupResources),
      },
      ...(cause.partialObservation === undefined
        ? {}
        : { partialObservation: cause.partialObservation }),
    },
  ).bindCleanupDependencies(owners);
  if (completed) return cleanup;
  const primary = translateOwnedArtifactFailure(operation, cause.outcome.cause);
  // Existing artifact callers inspect reason/detail/cause even while cleanup
  // is pending. Keep those fields, with the original failure as the live primary.
  let semanticPrimary = primary;
  while (semanticPrimary.cleanupPrimary !== undefined)
    semanticPrimary = semanticPrimary.cleanupPrimary;
  const error =
    semanticPrimary instanceof ArtifactOperationError
      ? new ArtifactOperationError(
          operation,
          semanticPrimary.reason,
          semanticPrimary.artifactDetails,
          semanticPrimary.detail,
          {
            cause: semanticPrimary.cause,
            cleanupPrimary: primary,
            cleanup: {
              reason: cause.cleanup?.reason ?? cleanup.message,
              resources: cause.cleanup?.resources ?? cleanup.cleanupResources,
            },
            ...(primary.partialObservation === undefined
              ? {}
              : { partialObservation: primary.partialObservation }),
            ...(semanticPrimary.userMessage === undefined
              ? {}
              : { userMessage: semanticPrimary.userMessage }),
            ...(semanticPrimary.admission === undefined
              ? {}
              : { admission: semanticPrimary.admission }),
          },
        )
      : analysisErrorWithCleanupFailure(primary, cleanup, operation);
  error.bindCleanupDependencies([primary, cleanup]);
  error.retainSecondaryFailure(cleanup);
  if (cause.partialObservation !== undefined)
    error.partialObservation = cause.partialObservation;
  return error;
};
