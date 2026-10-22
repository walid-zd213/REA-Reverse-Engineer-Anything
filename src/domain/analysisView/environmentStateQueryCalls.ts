import type { JsonValue } from "../jsonValue.js";
import {
  changesState,
  isObject,
  isParam,
  isStateWrite,
  QUERY_SEGMENTS,
  same,
  segmentsOf,
  type StateRecordFacts,
  type StateToolFacts,
} from "./environmentStateRules.js";
import { prefixRelated } from "./environmentStateWriteRules.js";

/** The words of a segment or operation name: split on `_`, `-`, `.` and camelCase, in lower case. */
const words = (text: string): string[] =>
  text
    .split(/[_\-.\s]+/u)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/u))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);

/** Path words that name a lookup rather than a change. */
const QUERY_WORDS = new Set([
  ...[...QUERY_SEGMENTS].flatMap(words),
  "ids",
  "selection",
  "discover",
]);
/** Trailing words that only qualify what a segment names, so the word before them decides. */
const NEUTRAL_WORDS = new Set(["data", "info", "results"]);
/** Whole path segments that renew or open a session rather than change state. */
const SESSION_SEGMENTS = new Set([
  "auth-refresh",
  "auth-with-password",
  "login",
  "logout",
  "refresh",
  "token",
]);
const READ_OPERATION_WORDS = new Set([
  "list",
  "get",
  "count",
  "aggregate",
  "info",
  "search",
  "find",
  "read",
  "query",
  "schema",
  "describe",
  "fetch",
  "lookup",
]);
const WRITE_OPERATION_WORDS = new Set([
  "create",
  "insert",
  "update",
  "delete",
  "remove",
  "upsert",
  "add",
  "set",
  "save",
  "patch",
  "put",
  "post",
  "write",
  "move",
  "copy",
  "duplicate",
  "import",
  "run",
  "execute",
  "trigger",
  "send",
  "reset",
  "clear",
  "archive",
  "restore",
]);
/** Operation names that only wrap the operations a request body names. */
const OPERATION_CONTAINERS = new Set(["batch", "bulk", "multi"]);
const OPERATION_PARAMETERS = ["operation", "op", "action"];

/** What deciding read-only calls reads besides the tools and the timeline. */
export interface QueryCallIo {
  readonly response: (ordinal: number) => JsonValue | undefined;
  readonly request: (ordinal: number) => JsonValue | undefined;
}

const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** A call that may have changed state without a 2xx answer saying what it did: redirected or unanswered. */
const unresolved = (record: StateRecordFacts): boolean =>
  isStateWrite(record) && !succeeded(record);

/** The names among these that are operations rather than containers wrapping them. */
const realOperations = (names: readonly (JsonValue | undefined)[]): string[] =>
  names.filter(
    (name): name is string =>
      typeof name === "string" && !OPERATION_CONTAINERS.has(name.toLowerCase()),
  );

/** The operations an RPC call names: its body's `operation` or `operations[].operation`, else its query's, containers aside. */
const operationsOf = (
  record: StateRecordFacts,
  body: JsonValue | undefined,
): string[] => {
  const named = isObject(body)
    ? realOperations([
        body.operation,
        ...(Array.isArray(body.operations)
          ? body.operations.map((entry) =>
              isObject(entry) ? entry.operation : undefined,
            )
          : []),
      ])
    : [];
  if (named.length > 0) return named;
  const query = new URLSearchParams(record.query ?? "");
  return realOperations(
    OPERATION_PARAMETERS.flatMap((name) => query.getAll(name)),
  );
};

/** An operation that reads: it names a read word and no write word. */
const readsOnly = (operation: string): boolean => {
  const named = words(operation);
  return (
    named.some((word) => READ_OPERATION_WORDS.has(word)) &&
    !named.some((word) => WRITE_OPERATION_WORDS.has(word))
  );
};

/**
 * POST tools whose recorded calls read state rather than change it, by the strongest evidence that
 * applies: a response repeating the latest read of the same path with no write between, an RPC
 * tunnel naming only read operations, a last path word naming a lookup, or a session segment. A
 * tool with a redirected or unanswered call stays a write, as does one a read line its path relates
 * to changes across, no write but the other read-only tools' calls between.
 */
export const readOnlyTools = (
  tools: readonly StateToolFacts[],
  records: readonly StateRecordFacts[],
  io: QueryCallIo,
): Set<string> => {
  const position = new Map(
    records.map((record, index) => [record.ordinal, index]),
  );
  const writesBetween =
    (skip: ReadonlySet<number>) =>
    (from: number, to: number): boolean =>
      records
        .slice(from + 1, to)
        .some((record) => !skip.has(record.ordinal) && isStateWrite(record));
  const candidates = new Map<string, readonly StateRecordFacts[]>();
  for (const tool of tools) {
    if (
      tool.method !== "POST" ||
      !changesState(tool.method, tool.path_template)
    )
      continue;
    const calls = tool.record_ordinals
      .map((ordinal) => records[position.get(ordinal) ?? -1])
      .filter((record): record is StateRecordFacts => record !== undefined);
    if (!calls.some(succeeded) || calls.some(unresolved)) continue;
    const between = writesBetween(new Set(tool.record_ordinals));
    if (
      repeatsRead(calls, records, { position, between, io }) ||
      namesReadOperations(calls, io) ||
      namesLookup(tool.path_template)
    )
      candidates.set(tool.name, calls);
  }
  // No candidate's call explains a read change across another's, so drop vetoed candidates until none is.
  for (let vetoed = true; vetoed;) {
    const between = writesBetween(
      new Set([...candidates.values()].flat().map((call) => call.ordinal)),
    );
    vetoed = false;
    for (const [name, calls] of candidates)
      if (changesReadsAcross(calls, records, { position, between, io })) {
        candidates.delete(name);
        vetoed = true;
      }
  }
  return new Set(candidates.keys());
};

interface Timeline {
  readonly position: ReadonlyMap<number, number>;
  readonly between: (from: number, to: number) => boolean;
  readonly io: QueryCallIo;
}

/** Every successful call answers as the latest earlier successful GET of its path did, with no write between. */
const repeatsRead = (
  calls: readonly StateRecordFacts[],
  records: readonly StateRecordFacts[],
  { position, between, io }: Timeline,
): boolean =>
  calls.filter(succeeded).every((call) => {
    const at = position.get(call.ordinal)!;
    const read = records
      .slice(0, at)
      .findLast(
        (record) =>
          record.method === "GET" &&
          record.path === call.path &&
          succeeded(record),
      );
    if (read === undefined || between(position.get(read.ordinal)!, at))
      return false;
    const answered = io.response(call.ordinal);
    return answered !== undefined && same(answered, io.response(read.ordinal));
  });

/** Every call names only read operations. */
const namesReadOperations = (
  calls: readonly StateRecordFacts[],
  io: QueryCallIo,
): boolean =>
  calls.every((call) => {
    const operations = operationsOf(call, io.request(call.ordinal));
    return operations.length > 0 && operations.every(readsOnly);
  });

/** The path's last literal segment is a session segment, or names a lookup by its last meaningful word and no write word. */
const namesLookup = (template: string): boolean => {
  const last = segmentsOf(template).findLast((segment) => !isParam(segment));
  if (last === undefined) return false;
  return (
    SESSION_SEGMENTS.has(last.toLowerCase()) ||
    (QUERY_WORDS.has(lastMeaningfulWord(last) ?? "") &&
      !words(last).some((word) => WRITE_OPERATION_WORDS.has(word)))
  );
};

/** A segment's last word that is not a trailing neutral word: `selection_data` names a selection, `query-history` a history. */
const lastMeaningfulWord = (segment: string): string | undefined =>
  words(segment).findLast((word) => !NEUTRAL_WORDS.has(word));

/** A GET line whose path a call's path relates to reads differently just before and just after it, with no other write between. */
const changesReadsAcross = (
  calls: readonly StateRecordFacts[],
  records: readonly StateRecordFacts[],
  { position, between, io }: Timeline,
): boolean =>
  calls.filter(succeeded).some((call) => {
    const at = position.get(call.ordinal)!;
    const lineOf = (record: StateRecordFacts): string =>
      `${record.path}${record.query ?? ""}`;
    const related = records.filter(
      (record) =>
        record.method === "GET" &&
        succeeded(record) &&
        prefixRelated(call.path, record.path),
    );
    return [...new Set(related.map(lineOf))].some((line) => {
      const before = related.findLast(
        (record) =>
          lineOf(record) === line && position.get(record.ordinal)! < at,
      );
      const after = related.find(
        (record) =>
          lineOf(record) === line && position.get(record.ordinal)! > at,
      );
      if (before === undefined || after === undefined) return false;
      const from = position.get(before.ordinal)!;
      const to = position.get(after.ordinal)!;
      if (between(from, at) || between(at, to)) return false;
      const earlier = io.response(before.ordinal);
      const later = io.response(after.ordinal);
      return (
        earlier !== undefined && later !== undefined && !same(earlier, later)
      );
    });
  });

/** The timeline's state writes, less the calls of tools whose calls only read, and those tools. */
export const stateWritesOf = (
  tools: readonly StateToolFacts[],
  records: readonly StateRecordFacts[],
  io: QueryCallIo,
): {
  readonly readOnly: ReadonlySet<string>;
  readonly writes: readonly StateRecordFacts[];
} => {
  const readOnly = readOnlyTools(tools, records, io);
  const reads = new Set(
    tools
      .filter((tool) => readOnly.has(tool.name))
      .flatMap((tool) => tool.record_ordinals),
  );
  return {
    readOnly,
    writes: records.filter(
      (record) => isStateWrite(record) && !reads.has(record.ordinal),
    ),
  };
};
