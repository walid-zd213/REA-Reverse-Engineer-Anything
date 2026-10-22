import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import type { StatePlan } from "./environmentStateGate.js";
import type { ObservedEntity } from "./environmentStateMerge.js";
import {
  isProjectionParameter,
  projectsFields,
  type ReplayKey,
  type StateRecordFacts,
} from "./environmentStateRules.js";

/** Query names that page a list rather than choose how it shows its entities. */
const PAGING = new Set([
  "limit",
  "offset",
  "page",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
  "start",
  "_start",
  "_end",
  "cursor",
  "pagenumber",
  "pageindex",
  "skip",
  "take",
  "top",
  "$top",
  "$skip",
]);

/** What one recorded line's objects showed: each entity's member names, and the members any and every object carried. */
export interface LineShape {
  readonly entities: ReadonlyMap<string, string>;
  readonly carried: ReadonlySet<string>;
  readonly common: ReadonlySet<string> | undefined;
}

/** Each name a query names, with every value it took. */
export const queryValues = (
  query: string | null | undefined,
): Map<string, string[]> => {
  const values = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(query ?? ""))
    values.set(name, [...(values.get(name) ?? []), value]);
  return values;
};

const shapingNames = (query: string | null | undefined): string[] =>
  [...queryValues(query).keys()].filter(
    (name) => !PAGING.has(name.toLowerCase()),
  );

/** The shape each observed recording showed of its entities, by ordinal. */
export const lineShapes = (
  entities: Iterable<ObservedEntity>,
): Map<number, LineShape> => {
  const shapes = new Map<
    number,
    {
      entities: Map<string, string>;
      carried: Set<string>;
      common: Set<string> | undefined;
    }
  >();
  for (const entity of entities)
    for (const observation of entity.observations) {
      const members = Object.keys(observation.object);
      let shape = shapes.get(observation.ordinal);
      if (shape === undefined) {
        shape = { entities: new Map(), carried: new Set(), common: undefined };
        shapes.set(observation.ordinal, shape);
      }
      shape.entities.set(
        JSON.stringify([entity.type, entity.collection, entity.id]),
        [...members].sort(compare).join(","),
      );
      for (const member of members) shape.carried.add(member);
      shape.common =
        shape.common === undefined
          ? new Set(members)
          : new Set(members.filter((member) => shape!.common!.has(member)));
    }
  return shapes;
};

const EMPTY: LineShape = {
  entities: new Map(),
  carried: new Set(),
  common: undefined,
};

/** Whether two lines show a shared entity with different members. */
const conflicts = (left: LineShape, right: LineShape): boolean =>
  [...left.entities].some(
    ([key, members]) =>
      right.entities.has(key) && right.entities.get(key) !== members,
  );

/** The latest lines that show the plan's entities in another representation than its base lines, as an expanding or reducing query does. */
export const variantLines = (
  latest: readonly StateRecordFacts[],
  shapeOf: (record: StateRecordFacts) => LineShape | undefined,
): StateRecordFacts[] => {
  if (latest.length < 2) return [];
  const shape = (record: StateRecordFacts): LineShape =>
    shapeOf(record) ?? EMPTY;
  const agreeing = new Map(
    latest.map((record) => [
      record,
      latest.filter(
        (other) => other !== record && !conflicts(shape(record), shape(other)),
      ).length,
    ]),
  );
  const size = (record: StateRecordFacts): number => shape(record).carried.size;
  const rank = (record: StateRecordFacts): number[] => [
    shapingNames(record.query).length === 0 ? 0 : 1,
    projectsFields(record.query ?? undefined) ? 1 : 0,
    -agreeing.get(record)!,
    shapingNames(record.query).length,
    size(record),
  ];
  // Base lines first: no shaping query, then no projection, then the line most others agree with.
  const ordered = [...latest].sort((left, right) => {
    const [a, b] = [rank(left), rank(right)];
    const differs = a.findIndex((value, index) => value !== b[index]);
    return differs === -1 ? 0 : a[differs]! - b[differs]!;
  });
  const base: StateRecordFacts[] = [];
  const variants: StateRecordFacts[] = [];
  for (const record of ordered) {
    if (base.length > 0 && isVariant(record, base, shape))
      variants.push(record);
    else base.push(record);
  }
  return variants;
};

/** Whether a line shows a base line's entity with other members, or names a new shaping parameter while its objects carry or lack members the base lines do not. */
const isVariant = (
  record: StateRecordFacts,
  base: readonly StateRecordFacts[],
  shape: (record: StateRecordFacts) => LineShape,
): boolean => {
  const mine = shape(record);
  if (base.some((line) => conflicts(mine, shape(line)))) return true;
  const baseNames = new Set(base.flatMap((line) => shapingNames(line.query)));
  if (!shapingNames(record.query).some((name) => !baseNames.has(name)))
    return false;
  const carried = new Set(base.flatMap((line) => [...shape(line).carried]));
  const commons = base.flatMap((line) => {
    const common = shape(line).common;
    return common === undefined ? [] : [common];
  });
  const common =
    commons.length === 0
      ? undefined
      : [...commons[0]!].filter((member) =>
          commons.every((set) => set.has(member)),
        );
  return (
    [...mine.carried].some((member) => !carried.has(member)) ||
    (mine.common !== undefined &&
      common !== undefined &&
      common.some((member) => !mine.common!.has(member)))
  );
};

/** The keys that tell replayed lines from base lines: a parameter or value only replayed lines give, or a parameter every base line names that one leaves out. */
export const replayKeys = (
  base: readonly (string | null | undefined)[],
  replayed: readonly (string | null | undefined)[],
): ReplayKey[] => {
  const baseValues = base.map(queryValues);
  const named = new Set(baseValues.flatMap((values) => [...values.keys()]));
  const everywhere = [...named].filter(
    (name) =>
      !PAGING.has(name.toLowerCase()) &&
      baseValues.every((values) => values.has(name)),
  );
  const keys = new Map<string, ReplayKey>();
  const add = (key: ReplayKey): void => {
    keys.set(
      JSON.stringify([key.name, key.value ?? null, key.absent ?? false]),
      key,
    );
  };
  for (const query of replayed) {
    const values = queryValues(query);
    for (const [name, given] of values) {
      if (PAGING.has(name.toLowerCase())) continue;
      const unseen = given.filter(
        (value) =>
          !baseValues.some(
            (other) => other.get(name)?.includes(value) === true,
          ),
      );
      if (!named.has(name)) add({ name });
      else for (const value of unseen) add({ name, value });
    }
    for (const name of everywhere)
      if (!values.has(name)) add({ name, absent: true });
  }
  return [...keys.values()].sort(
    (left, right) =>
      compare(left.name, right.name) ||
      compare(left.value ?? "", right.value ?? "") ||
      Number(left.absent ?? false) - Number(right.absent ?? false),
  );
};

/** Whether a call's query names a replay key: the parameter, the parameter with that value, or leaves out an absent key's parameter. */
export const matchesReplayKey = (
  keys: readonly ReplayKey[],
  call: ReadonlyMap<string, readonly string[]>,
): boolean =>
  keys.some((key) =>
    key.absent === true
      ? !call.has(key.name)
      : key.value === undefined
        ? call.has(key.name)
        : call.get(key.name)?.includes(key.value) === true,
  );

/** Whether a call asks for a selection of fields the checked lines do not show exactly: a projection value a replayed line gave, or one no checked line gave other than `*`. */
export const selectsOtherFields = (
  call: ReadonlyMap<string, readonly string[]>,
  checked: readonly (string | null | undefined)[],
  replayed: readonly (string | null | undefined)[],
): boolean => {
  const [base, other] = [checked.map(queryValues), replayed.map(queryValues)];
  const gave = (lines: Map<string, string[]>[], name: string, value: string) =>
    lines.some((values) => values.get(name)?.includes(value) === true);
  return [...call].some(
    ([name, values]) =>
      isProjectionParameter(name) &&
      values.some(
        (value) =>
          gave(other, name, value) ||
          (value !== "*" && !gave(base, name, value)),
      ),
  );
};

const requestLine = (record: StateRecordFacts): string =>
  record.path + (record.query ?? "");

/** The plan with the variants a key picks out moved to its replayed reads and their recordings dropped, or undefined when it replays nothing. */
export const withoutVariants = (
  plan: StatePlan,
  facts: {
    readonly shapeOf: (record: StateRecordFacts) => LineShape | undefined;
    readonly queryOf: (ordinal: number) => string | null | undefined;
    readonly position: (ordinal: number) => number;
  },
):
  | { readonly plan: StatePlan; readonly dropped: ReadonlySet<number> }
  | undefined => {
  const found = variantLines(plan.latest, facts.shapeOf);
  const unkeyed = plan.latest.filter((record) => !found.includes(record));
  const variants = found.filter(
    (record) =>
      replayKeys(
        unkeyed.map((line) => line.query),
        [record.query],
      ).length > 0,
  );
  const projected = plan.projected ?? [];
  if (variants.length === 0 && projected.length === 0) return undefined;
  const lines = new Set(variants.map(requestLine));
  const latest = plan.latest.filter(
    (record) => !lines.has(requestLine(record)),
  );
  const replayed = [
    ...projected,
    ...variants.map((record) => record.ordinal),
  ].sort((left, right) => facts.position(left) - facts.position(right));
  const dropped = new Set(
    plan.recordings
      .filter((record) => lines.has(requestLine(record)))
      .map((record) => record.ordinal),
  );
  return {
    plan: {
      ...plan,
      recordings: plan.recordings.filter(
        (record) => !dropped.has(record.ordinal),
      ),
      latest,
      projected: replayed,
      projectedKeys: replayKeys(
        latest.map((record) => record.query),
        replayed.map(facts.queryOf),
      ),
    },
    dropped,
  };
};

/** Forget the observations of dropped recordings, and entities only they showed. */
export const dropObservations = (
  entities: Map<string, ObservedEntity>,
  dropped: ReadonlySet<number>,
): void => {
  for (const [key, entity] of entities) {
    const kept = entity.observations.filter(
      (observation) => !dropped.has(observation.ordinal),
    );
    if (kept.length === entity.observations.length) continue;
    if (kept.length === 0) entities.delete(key);
    else entities.set(key, { ...entity, observations: kept });
  }
};
