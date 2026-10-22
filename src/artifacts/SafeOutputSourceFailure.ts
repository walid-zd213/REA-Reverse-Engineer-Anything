import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "./ArtifactReader.js";

/** Retain source errors separately from cleanup facts supplied by their owners. */
export class SafeOutputSourceFailure extends ArtifactReaderFailure {
  readonly sourceFailures: readonly unknown[];

  constructor(
    primary: unknown,
    sourceFailures: readonly unknown[],
    /** The write owner observed this primary on the input stream. */
    readonly primaryIsSource = false,
  ) {
    const normalizedPrimary = ArtifactReaderFailure.from(primary);
    const cleanupFailures = sourceFailures
      .map((failure) => ArtifactReaderFailure.from(failure))
      .filter((failure) => failure.cleanup !== undefined);
    const observations = cleanupFailures.flatMap((failure) =>
      failure.cleanup === undefined ? [] : [failure.cleanup],
    );
    const inherited = artifactPrimaryCleanupLeases(normalizedPrimary);
    const sourceLeases = cleanupFailures.map(
      (failure) => failure.cleanupLeases,
    );
    const projected =
      cleanupFailures.length === 0
        ? normalizedPrimary
        : ArtifactReaderFailure.withCleanup(
            normalizedPrimary,
            {
              reason: observations.map(({ reason }) => reason).join("; "),
              resources: [
                ...new Set(observations.flatMap(({ resources }) => resources)),
              ],
            },
            undefined,
            inherited === undefined ||
              sourceLeases.some((leases) => leases === undefined)
              ? undefined
              : [
                  ...new Set([
                    ...inherited,
                    ...sourceLeases.flatMap((leases) => leases ?? []),
                  ]),
                ],
          );
    super(
      projected.reason,
      projected.message,
      {
        // Classification fields are snapshots; the primary retains its live owner.
        cause: primary,
        cancellation: projected.cancellation,
        cleanup: projected.cleanup,
        cleanupLeases: projected.cleanupLeases,
        partialObservation: projected.partialObservation,
        ...(projected.boundary === undefined
          ? {}
          : { boundary: projected.boundary }),
      },
      projected.details,
    );
    // Individual producers still retain their exact leases when the combined
    // observation also contains a failure with no known cleanup authority.
    this.sourceFailures = [...sourceFailures];
  }
}
