import { canonicalJson } from "../comparisonSemantics.js";
import type { JsonValue } from "../jsonValue.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import {
  at,
  collectionPathOf,
  isObject,
  lastSegmentValue,
  listItems,
  renderStateEntity,
  renderStateList,
  replaceAt,
  same,
  scalarText,
  type JsonObject,
  type RecordedViewReason,
  type ReplayKey,
  type StateEntity,
  type StateItemView,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";
import {
  evaluateQuery,
  learnQuery,
  lineChoices,
  queryTotalCount,
  renderQueryList,
  type ListQuery,
  type QueryLine,
} from "./environmentStateListQuery.js";
import { singleQueryValues } from "../recordedTransportUrl.js";
import { startsAtBeginning } from "./environmentStatePaging.js";
import { readClock, type ClockFormat } from "./environmentStateWriteValues.js";
import { ENTRY_BYTES, textBytes } from "./webNetworkRouteTemplates.js";

/** A read tool whose recordings locate entities of one type at one pointer. */
export interface StatePlan {
  readonly tool: StateToolFacts;
  readonly item: boolean;
  readonly type: string;
  readonly pointer: string;
  /** Successful init recordings in timeline order. */
  readonly recordings: readonly StateRecordFacts[];
  /** The latest of them per request line, in timeline order. */
  readonly latest: readonly StateRecordFacts[];
  /** Reads left to replay: item reads that asked for some fields only, and representation variants. */
  readonly projected?: readonly number[];
  /** The query keys that pick calls of the replayed reads out. */
  readonly projectedKeys?: readonly ReplayKey[];
}

/** A view's replayed reads and their keys, when it has any. */
const replayedReads = (
  plan: StatePlan,
): Pick<StateItemView, "projected_record_ordinals" | "projected_query_keys"> =>
  plan.projected === undefined || plan.projected.length === 0
    ? {}
    : {
        projected_record_ordinals: [...plan.projected],
        ...(plan.projectedKeys === undefined || plan.projectedKeys.length === 0
          ? {}
          : { projected_query_keys: [...plan.projectedKeys] }),
      };

/** What the gate reads from an extraction; `withBody` drops each body's temporary work after `use`. */
export interface StateGateContext {
  readonly withBody: <T>(
    ordinal: number,
    use: (body: JsonValue | undefined) => T,
  ) => T;
  readonly retain: (bytes: number) => void;
  readonly entity: (
    type: string,
    collection: string,
    id: string,
  ) => StateEntity | undefined;
  readonly inCollection: (type: string, collection: string) => StateEntity[];
  readonly volatileOf: (type: string) => ReadonlySet<string>;
  readonly idField: (type: string) => string;
}

/** Ordered key union and always-present keys, grown one object at a time. */
class FieldUnion {
  readonly fields: string[] = [];
  /** Membership beside the ordered list, so a wide object is not scanned per key. */
  readonly #seen = new Set<string>();
  #required: Set<string> | undefined;

  add(object: JsonObject): void {
    for (const key of Object.keys(object))
      if (!this.#seen.has(key)) {
        this.#seen.add(key);
        this.fields.push(key);
      }
    const keys = new Set(Object.keys(object));
    this.#required =
      this.#required === undefined
        ? keys
        : new Set([...this.#required].filter((key) => keys.has(key)));
  }

  get required(): string[] {
    return this.fields.filter((key) => this.#required?.has(key) === true);
  }

  /** Retained bytes of the field lists a plan keeps. */
  get bytes(): number {
    return this.fields.reduce(
      (sum, name) => sum + ENTRY_BYTES * 2 + textBytes(name.length) * 2,
      ENTRY_BYTES * 2,
    );
  }
}

/** The spellings a view always gives clock fields where its recordings spell the stored instant otherwise. */
class ClockSpellings {
  /** Each category retains one spelling or a permanent mixed marker, never an expanding format history. */
  readonly #fields = new Map<
    string,
    {
      matched: ClockFormat | null | undefined;
      other: ClockFormat | null | undefined;
    }
  >();

  constructor(private readonly retain: StateGateContext["retain"]) {
    retain(ENTRY_BYTES);
  }

  #note(
    field: string,
    category: "matched" | "other",
    format: ClockFormat | null,
  ): void {
    let facts = this.#fields.get(field);
    if (facts === undefined) {
      this.retain(ENTRY_BYTES + textBytes(field.length));
      facts = { matched: undefined, other: undefined };
      this.#fields.set(field, facts);
    }
    const held = facts[category];
    if (held === undefined) {
      if (format !== null)
        this.retain(
          ENTRY_BYTES +
            (format.kind === "iso" ? textBytes(format.zone.length) : 0),
        );
      facts[category] = format;
    } else if (held !== null && !same(held, format)) facts[category] = null;
  }

  note(stored: JsonObject, shown: JsonObject): void {
    for (const [field, value] of Object.entries(shown)) {
      const now = readClock(value);
      if (now === undefined) continue;
      const was = Object.hasOwn(stored, field)
        ? readClock(stored[field])
        : undefined;
      if (
        was === undefined ||
        was.ms !== now.ms ||
        was.subMillisecond !== now.subMillisecond
      ) {
        this.#note(field, "other", now.format);
        continue;
      }
      const spelled = same(stored[field], value) ? null : now.format;
      this.#note(field, "matched", spelled);
    }
  }

  /** The view member, when the view spells any field otherwise, and in that spelling only. */
  get view(): { readonly clock_formats?: Record<string, ClockFormat> } {
    const formats: [string, ClockFormat][] = [];
    for (const [field, { matched, other }] of this.#fields) {
      if (
        matched === undefined ||
        matched === null ||
        other === null ||
        (other !== undefined && !same(other, matched))
      )
        continue;
      if (formats.length === 0) this.retain(ENTRY_BYTES * 2);
      // Both the temporary entry and its returned object member remain covered.
      this.retain(ENTRY_BYTES * 2 + textBytes(field.length));
      formats.push([field, matched]);
    }
    return formats.length === 0
      ? {}
      : { clock_formats: Object.fromEntries(formats) };
  }
}

const recorded = (plan: StatePlan, reason: RecordedViewReason): StateView => ({
  tool: plan.tool.name,
  shape: "recorded",
  reason,
});

/** Why one latest item recording does not render from the shared envelope and the entity's state, if it does not. */
const itemMismatch = (
  context: StateGateContext,
  plan: StatePlan,
  check: {
    readonly view: { readonly tool: string; readonly fields: string[] };
    readonly envelope: { skeleton?: string };
    readonly spellings: ClockSpellings;
  },
  record: StateRecordFacts,
): RecordedViewReason | undefined => {
  const { view, envelope } = check;
  const entity = context.entity(
    plan.type,
    collectionPathOf(record, true),
    lastSegmentValue(record.path),
  );
  return context.withBody(record.ordinal, (body) => {
    const object = body === undefined ? undefined : at(body, plan.pointer);
    if (entity === undefined || body === undefined || !isObject(object))
      return "fields-differ";
    const skeleton = canonicalJson(
      replaceAt(body, plan.pointer, null),
      "Environment state",
    );
    if (envelope.skeleton === undefined) {
      context.retain(textBytes(skeleton.length));
      envelope.skeleton = skeleton;
    }
    if (skeleton !== envelope.skeleton) return "envelope-varies";
    check.spellings.note(entity.fields, object);
    const shown = renderStateEntity(
      entity,
      view,
      context.volatileOf(plan.type),
      object,
    );
    return same(shown, object) ? undefined : "fields-differ";
  });
};

/** An item plan must reproduce each latest recording from the first one's envelope and the entity's state. */
export const checkItemPlan = (
  context: StateGateContext,
  plan: StatePlan,
): StateView => {
  const union = new FieldUnion();
  for (const record of plan.latest)
    context.withBody(record.ordinal, (body) => {
      const object = body === undefined ? undefined : at(body, plan.pointer);
      if (isObject(object)) union.add(object);
    });
  context.retain(union.bytes);
  const view = { tool: plan.tool.name, fields: union.fields };
  const envelope: { skeleton?: string } = {};
  const spellings = new ClockSpellings(context.retain);
  for (const record of plan.latest) {
    const reason = itemMismatch(
      context,
      plan,
      { view, envelope, spellings },
      record,
    );
    if (reason !== undefined) return recorded(plan, reason);
  }
  return {
    tool: plan.tool.name,
    shape: "item",
    type: plan.type,
    pointer: plan.pointer,
    fields: union.fields,
    required_fields: union.required,
    envelope_ordinal: plan.latest[0]!.ordinal,
    checked_record_ordinals: plan.latest.map((record) => record.ordinal),
    ...replayedReads(plan),
    ...spellings.view,
  };
};

/** The latest recordings that list their whole collection in state order, and the counters that equal the item count on each of them, or on every line when none does. */
const listFacts = (
  context: StateGateContext,
  plan: StatePlan,
  union: FieldUnion,
): { readonly whole: ReadonlySet<number>; readonly counters: string[] } => {
  const field = context.idField(plan.type);
  const whole = new Set<number>();
  const counting = new Map<number, string[]>();
  for (const record of plan.latest)
    context.withBody(record.ordinal, (body) => {
      const items =
        body === undefined ? undefined : listItems(body, plan.pointer);
      if (body === undefined || items === undefined) return;
      items.forEach((item) => union.add(item));
      const parent = plan.pointer === "" || !isObject(body) ? {} : body;
      const counted = Object.keys(parent).filter(
        (name) => isItemTotal(name) && countOf(parent[name]) !== undefined,
      );
      counting.set(
        record.ordinal,
        counted.filter((name) => parent[name] === items.length),
      );
      // Only a line that pages at most can hold its whole collection; a total that differs from
      // the number listed, or a next page, shows it is partial.
      if (
        !startsAtBeginning(record.query) ||
        counted.some((name) => countOf(parent[name]) !== items.length) ||
        Object.keys(parent).some((name) => continues(name, parent[name]))
      )
        return;
      const ids = items.map((item) => scalarText(item[field]) ?? "");
      const expected = context
        .inCollection(plan.type, collectionPathOf(record, false))
        .map((entity) => entity.id);
      if (same(ids, expected)) whole.add(record.ordinal);
    });
  // Counter presence is per envelope. Keep every observed page counter;
  // renderStateList updates only one the selected base actually counted.
  const counters = [...new Set([...counting.values()].flat())].sort(compare);
  return { whole, counters };
};

const nameTokens = (name: string): string[] =>
  name
    .split(/[_\-\s]|(?<=[a-z0-9])(?=[A-Z])/u)
    .map((token) => token.toLowerCase());

const LISTED_NOUNS = new Set(["elements", "entries", "items", "results"]);

/** Item totals, including compact `totalcount`/`itemcount` and `numberOfElements`; page counts and account IDs are excluded. */
const isItemTotal = (name: string): boolean => {
  const tokens = nameTokens(name);
  return (
    (tokens.some(
      (token) =>
        token === "total" ||
        token === "count" ||
        token === "totalcount" ||
        token === "itemcount",
    ) ||
      (tokens.includes("number") &&
        tokens.some((token) => LISTED_NOUNS.has(token)))) &&
    !tokens.some(
      (token) => token === "page" || token === "pages" || token === "per",
    )
  );
};

/** A count recorded as a number or as a string of digits. */
const countOf = (value: JsonValue | undefined): number | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : undefined;

const CONTINUATION_NAMES = new Set([
  "hasmore",
  "next",
  "nextcursor",
  "nextpage",
  "nextpagetoken",
  "nexttoken",
]);

/** A top-level `has_more`, `next` or next-page token member that says more items follow. */
const continues = (name: string, value: JsonValue | undefined): boolean =>
  CONTINUATION_NAMES.has(nameTokens(name).join("")) &&
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== "";

/** The query that lines which are not whole follow, with the item totals that count its matches before paging. */
const listQuery = (
  context: StateGateContext,
  plan: StatePlan,
  whole: ReadonlySet<number>,
): ListQuery | undefined => {
  const field = context.idField(plan.type);
  const lines: QueryLine[] = [];
  const counts = new Map<number, [string, number][]>();
  for (const record of plan.latest) {
    const values = whole.has(record.ordinal)
      ? undefined
      : singleQueryValues(record.query);
    if (values === undefined || values.size === 0) continue;
    context.withBody(record.ordinal, (body) => {
      const items =
        body === undefined ? undefined : listItems(body, plan.pointer);
      if (body === undefined || items === undefined) return;
      const choices = lineChoices(values, items);
      context.retain(ENTRY_BYTES * (items.length + choices.length * 4 + 2));
      lines.push({
        ordinal: record.ordinal,
        values,
        choices,
        listed: items.map((item) => scalarText(item[field]) ?? ""),
        entities: context.inCollection(
          plan.type,
          collectionPathOf(record, false),
        ),
      });
      const parent = plan.pointer === "" || !isObject(body) ? {} : body;
      counts.set(
        record.ordinal,
        Object.keys(parent).flatMap((name): [string, number][] => {
          const count = isItemTotal(name)
            ? queryTotalCount(parent[name])
            : undefined;
          return count === undefined ? [] : [[name, count]];
        }),
      );
    });
  }
  const learned = learnQuery(lines);
  if (learned === undefined) return undefined;
  // Totals count every match on each line the query answers; a `number`-of-items member counts the page.
  const totals = new Set<string>();
  const contradicted = new Set<string>();
  const answered = new Set(learned.record_ordinals);
  for (const line of lines) {
    if (!answered.has(line.ordinal)) continue;
    const { total } = evaluateQuery(
      learned.parameters,
      line.values,
      line.entities,
    )!;
    // Absence says nothing about another envelope's counter. Only a present
    // count that disagrees invalidates the shared total interpretation.
    for (const [name, count] of counts.get(line.ordinal) ?? []) {
      if (nameTokens(name).includes("number")) continue;
      if (count === total) totals.add(name);
      else contradicted.add(name);
    }
  }
  return {
    ...learned,
    totals: [...totals].filter((name) => !contradicted.has(name)).sort(compare),
  };
};

/** Whether one latest list recording renders from its own envelope and the state: the whole collection, the query's matches, or the listed entities. */
const listReproduces = (
  context: StateGateContext,
  plan: StatePlan,
  check: {
    readonly view: {
      readonly tool: string;
      readonly fields: string[];
      readonly pointer: string;
      readonly counters: string[];
      readonly whole: ReadonlySet<number>;
      readonly query: ListQuery | undefined;
    };
    readonly spellings?: ClockSpellings;
  },
  record: StateRecordFacts,
): boolean => {
  const { view, spellings } = check;
  const field = context.idField(plan.type);
  const collection = collectionPathOf(record, false);
  return context.withBody(record.ordinal, (body) => {
    const items =
      body === undefined ? undefined : listItems(body, plan.pointer);
    if (body === undefined || items === undefined) return false;
    const observed = new Map(
      items.map((item) => [scalarText(item[field]) ?? "", item]),
    );
    const computed = view.query?.record_ordinals.includes(record.ordinal)
      ? evaluateQuery(
          view.query.parameters,
          singleQueryValues(record.query) ?? new Map(),
          context.inCollection(plan.type, collection),
        )
      : undefined;
    const members = view.whole.has(record.ordinal)
      ? context.inCollection(plan.type, collection)
      : (computed?.page ??
        items.flatMap((item) => {
          const entity = context.entity(
            plan.type,
            collection,
            scalarText(item[field]) ?? "",
          );
          return entity === undefined ? [] : [entity];
        }));
    const rendered = members.map((entity) => {
      const item = observed.get(entity.id);
      if (item !== undefined) spellings?.note(entity.fields, item);
      return renderStateEntity(
        entity,
        view,
        context.volatileOf(plan.type),
        item,
      );
    });
    const answer =
      view.query === undefined ||
      (computed === undefined && !view.whole.has(record.ordinal))
        ? renderStateList(view, body, rendered)
        : renderQueryList(
            { ...view, query: view.query },
            body,
            rendered,
            computed?.total ?? rendered.length,
          );
    return same(answer, body);
  });
};

/** A list plan must reproduce each latest recording from its own envelope and the listed entities' state. */
export const checkListPlan = (
  context: StateGateContext,
  plan: StatePlan,
): StateView => {
  const union = new FieldUnion();
  const { whole, counters } = listFacts(context, plan, union);
  context.retain(union.bytes);
  const base = {
    tool: plan.tool.name,
    fields: union.fields,
    pointer: plan.pointer,
    counters,
    whole,
  };
  let query = listQuery(context, plan, whole);
  // A line the query explains but whose envelope or fields the state does not reproduce keeps its recorded members.
  if (query !== undefined) {
    const failing = plan.latest.filter(
      (record) =>
        query!.record_ordinals.includes(record.ordinal) &&
        !listReproduces(context, plan, { view: { ...base, query } }, record),
    );
    const kept = query.record_ordinals.filter(
      (ordinal) => !failing.some((record) => record.ordinal === ordinal),
    );
    query = kept.length === 0 ? undefined : { ...query, record_ordinals: kept };
  }
  const view = { ...base, query };
  const all = plan.latest.every((record) => whole.has(record.ordinal));
  const spellings = new ClockSpellings(context.retain);
  if (
    !plan.latest.every((record) =>
      listReproduces(context, plan, { view, spellings }, record),
    )
  )
    return recorded(plan, "list-differs");
  return {
    tool: plan.tool.name,
    shape: "list",
    type: plan.type,
    pointer: plan.pointer,
    fields: union.fields,
    required_fields: union.required,
    membership: all ? "all" : "recorded",
    ...(all || whole.size === 0
      ? {}
      : {
          all_record_ordinals: plan.latest
            .map((record) => record.ordinal)
            .filter((ordinal) => whole.has(ordinal)),
        }),
    counters,
    ...(query === undefined ? {} : { query }),
    checked_record_ordinals: plan.latest.map((record) => record.ordinal),
    ...replayedReads(plan),
    ...spellings.view,
  };
};
