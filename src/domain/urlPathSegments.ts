import { posix } from "node:path";

/** A URL path while its empty segments and above-root traversal still matter. */
export interface UrlPathState {
  readonly escapes: number;
  readonly segments: readonly string[];
}

export const urlDirectoryState = (directory: string): UrlPathState => ({
  escapes: 0,
  segments: directory === "" || directory === "." ? [] : directory.split("/"),
});

/** Apply URL dot segments before repeated separators can be collapsed. */
export const applyUrlReference = (
  base: UrlPathState,
  reference: string,
  encodedDotSegments = false,
): UrlPathState => {
  const absolute = reference.startsWith("/");
  const segments = absolute ? [] : [...base.segments];
  let escapes = absolute ? 0 : base.escapes;
  const parts = (absolute ? reference.slice(1) : reference).split("/");
  for (const [index, part] of parts.entries()) {
    const dot = encodedDotSegments ? part.replace(/%2e/giu, ".") : part;
    if (dot !== "." && dot !== "..") {
      segments.push(part);
      continue;
    }
    if (dot === "..")
      if (segments.length > 0) segments.pop();
      else escapes += 1;
    if (index === parts.length - 1) segments.push("");
  }
  return { escapes, segments };
};

/** A relative URL reference replaces the base URL's final path segment. */
export const urlBaseDirectory = (base: UrlPathState): UrlPathState => ({
  escapes: base.escapes,
  segments: base.segments.slice(0, -1),
});

/** An interior empty segment cannot name an exact canonical artifact file. */
export const urlPathCandidate = (path: UrlPathState): string | null => {
  const segments =
    path.segments.at(-1) === "" ? path.segments.slice(0, -1) : path.segments;
  if (segments.includes("")) return null;
  return [
    ...Array.from({ length: path.escapes }, () => ".."),
    ...segments,
  ].join("/");
};

/** Resolve a URL path reference against a canonical directory. */
export const urlRelativePath = (
  directory: string,
  reference: string,
): string | null =>
  urlPathCandidate(applyUrlReference(urlDirectoryState(directory), reference));

/** Resolve URL dot segments first, then collapse separators for filesystem lookup. */
export const urlRelativeFilesystemPath = (
  directory: string,
  reference: string,
): string => {
  const path = applyUrlReference(urlDirectoryState(directory), reference);
  const segments =
    path.segments.at(-1) === "" ? path.segments.slice(0, -1) : path.segments;
  const joined = [
    ...Array.from({ length: path.escapes }, () => ".."),
    ...segments,
  ].join("/");
  const normalized = posix.normalize(
    reference.startsWith("/") ? joined : `./${joined}`,
  );
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};
