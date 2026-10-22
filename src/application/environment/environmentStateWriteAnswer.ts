import {
  createdFields,
  documentBodyProblem,
  renewUuids,
  updatedEntity,
  updatedFields,
  valueAt,
  writtenDocument,
  writtenResponse,
  type GenerateValue,
} from "../../domain/analysisView/environmentStateWriteApply.js";
import {
  insertIndex,
  nextInteger,
} from "../../domain/analysisView/environmentStateWriteExplain.js";
import { callRenewal } from "../../domain/analysisView/environmentStateWriteGenerated.js";
import {
  linkedCollection,
  sameLinkedSource,
} from "../../domain/analysisView/environmentStateWriteLinks.js";
import {
  pathValuesOf,
  type GeneratedRule,
  type StateWritePlan,
  type WriteCall,
} from "../../domain/analysisView/environmentStateWriteRules.js";
import {
  formatClock,
  isUuid,
  seededToken,
  seededUuid,
  spelledLike,
} from "../../domain/analysisView/environmentStateWriteValues.js";
import {
  collectionMatch,
  isObject,
  scalarText,
  type JsonObject,
  type StateEntity,
} from "../../domain/analysisView/environmentStateRules.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  replayAnswer,
  selectReplayExchange,
  type ReplayArguments,
} from "./environmentReplay.js";
import type { EnvironmentManifestTool } from "./environmentSource.js";
import { callSegments } from "./environmentStateCallLines.js";
import {
  itemCall,
  missingAnswer,
  namedEntity,
  recordedJson,
  refused,
  stateAnswer,
  type StateAnswer,
  type StateProvenance,
  type StateServing,
} from "./environmentStateAnswer.js";
import { createdCollection } from "./environmentStateCollections.js";
import {
  isLoadableValue,
  unloadableMember,
  type HeldDocument,
} from "./environmentStateDocument.js";
import { environmentToolArguments } from "./environmentTools.js";

/** Attempts at a generated UUID or token before a collision with held values is refused. */
const GENERATION_ATTEMPTS = 64;

/** One served write call: the tool, its plan and its arguments. */
interface WriteRequest {
  readonly tool: EnvironmentManifestTool;
  readonly plan: StateWritePlan;
  readonly args: ReplayArguments;
}

/** The path values a call supplies, keyed by template segment as write plans name them. */
const pathValues = (
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): Map<string, string> => {
  const names = environmentToolArguments(tool).path;
  const template = tool.path_template
    .slice(tool.path_template.indexOf("/") + 1)
    .split("/");
  const values = new Map<string, string>();
  for (const param of tool.params) {
    const value = args[names.get(param.name) ?? param.name];
    const segment = template[param.index] ?? "";
    if (typeof value === "string") values.set(segment.slice(1, -1), value);
  }
  return values;
};

/** A refusal for a value `data/add` would refuse, so `data/get` always reports a state that loads back. */
const unloadable = (
  tool: EnvironmentManifestTool,
  holder: string,
): AnalysisError =>
  refused(
    tool,
    `${holder} would hold a value that is not exactly representable JSON, which data/add could not load back.`,
  );

/** The call's body: an object, nothing, or a refusal for any other value or one holding a value the state cannot hold. */
const callBody = ({
  tool,
  args,
}: WriteRequest): Result<JsonObject | undefined, AnalysisError> => {
  const name = environmentToolArguments(tool).body;
  const value = name === undefined ? undefined : args[name];
  if (value === undefined) return ok(undefined);
  if (!isObject(value as JsonValue))
    return err(refused(tool, `Tool ${tool.name} takes a JSON object body.`));
  const member = unloadableMember(value as JsonObject);
  return member === undefined
    ? ok(value as JsonObject)
    : err(unloadable(tool, `Member ${member}`));
};

/** The entity a recorded observation shows: the values a create keeps and an update's constants. */
const observedEntity = (
  serving: StateServing,
  plan: StateWritePlan,
): JsonObject | undefined => {
  if (plan.observation === null) return undefined;
  const exchange = serving.source.exchanges.get(plan.observation.ordinal);
  const body = exchange === undefined ? undefined : recordedJson(exchange);
  const object =
    body === undefined ? undefined : valueAt(body, plan.observation.pointer);
  return isObject(object) ? object : undefined;
};

/** One past the largest integer these entities hold in the field, read as the exemplar spells it, or undefined when none holds one. */
const nextHeld = (
  entities: readonly StateEntity[],
  field: string,
  exemplar: JsonValue,
) =>
  nextInteger(
    entities.map((entity) => entity.fields),
    field,
    exemplar,
  );

/**
 * Values one served write generates: its clock instant, sequences one past the largest held
 * value, and UUIDs and tokens seeded by the state Evidence, tool, field and write count,
 * skipping values the type already holds.
 */
const generator = (
  serving: StateServing,
  request: WriteRequest,
  target: {
    readonly name: string;
    readonly collection: readonly StateEntity[];
    readonly observed: JsonObject;
    /** The entity an update writes, whose values a renewed field keeps. */
    readonly current?: JsonObject;
  },
): {
  readonly generate: GenerateValue;
  readonly taken: Map<string, number>;
} => {
  const { store } = serving;
  const write = store.pendingWrite();
  const taken = new Map<string, number>();
  const sequence = (key: string, held: number | undefined): number => {
    const value = store.sequenceAfter(key, held);
    taken.set(key, value);
    return value;
  };
  const ofType = store.ofType(request.plan.target ?? "");
  // A sequence never reuses a value the state started with, even after its entity was deleted.
  const started = store.startedWith(request.plan.target ?? "");
  const startedIn = started.filter((held) => held.collection === target.name);
  const renewed = callRenewal(
    `${store.state.evidenceId}:${request.tool.name}:renewed:${String(write.count)}`,
  );
  const unused = (
    field: string,
    make: (attempt: number) => string,
  ): Result<string, string> => {
    const held = new Set(
      ofType.map((entity) => scalarText(entity.fields[field])),
    );
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      const value = make(attempt);
      if (!held.has(value)) return ok(value);
    }
    return err(
      `Could not generate a unique value for ${field} after ${String(GENERATION_ATTEMPTS)} attempts without colliding with the held state.`,
    );
  };
  const generate = (rule: GeneratedRule): Result<JsonValue, string> => {
    const exemplar = target.observed[rule.field] ?? "";
    const seed = (attempt: number) =>
      `${store.state.evidenceId}:${request.tool.name}:${rule.field}:${String(write.count)}:${String(attempt)}`;
    switch (rule.rule) {
      case "clock":
        return ok(formatClock(write.clockMs, rule.format));
      case "sequence":
        return ok(
          spelledLike(
            exemplar,
            sequence(
              `${request.tool.name} ${rule.field} ${rule.scope === "collection" ? target.name : ""}`,
              nextHeld(
                rule.scope === "collection"
                  ? [...target.collection, ...startedIn]
                  : [...ofType, ...started],
                rule.field,
                exemplar,
              ),
            ),
          ),
        );
      case "unique":
        return unused(rule.field, (attempt) =>
          seededUuid(seed(attempt), String(exemplar)),
        );
      case "renewed":
        return ok(
          renewUuids(
            target.current?.[rule.field] ?? null,
            rule.pointers,
            renewed,
          ),
        );
      case "identity":
        if (rule.generator === "sequence")
          return ok(
            spelledLike(
              exemplar,
              sequence(
                `${request.plan.target ?? ""} ${rule.field} ${target.name}`,
                nextHeld(
                  [...target.collection, ...startedIn],
                  rule.field,
                  exemplar,
                ),
              ),
            ),
          );
        return unused(rule.field, (attempt) =>
          rule.generator === "uuid" || isUuid(exemplar)
            ? seededUuid(seed(attempt), String(exemplar))
            : seededToken(seed(attempt), String(exemplar)),
        );
    }
  };
  return { generate, taken };
};

/** A write's answer on its recorded response's status and content type: a rendered body, none, or the recorded one. */
const writeAnswer = (
  serving: StateServing,
  request: WriteRequest,
  rendered: { readonly fields: JsonObject | undefined; readonly id: string },
  state: StateProvenance,
): Result<StateAnswer, AnalysisError> => {
  const { plan, tool, args } = request;
  const exchange =
    plan.response === null
      ? undefined
      : serving.source.exchanges.get(plan.response.ordinal);
  if (plan.response === null || exchange === undefined)
    return err(refused(tool, `Tool ${tool.name} has no recorded response.`));
  const exact =
    selectReplayExchange(tool, new Map([[exchange.ordinal, exchange]]), args)
      ?.exact === true;
  if (plan.response.shape === "recorded")
    return ok({ ...replayAnswer(serving.source, exchange, exact), state });
  const body = writtenResponse(plan.response, recordedJson(exchange), rendered);
  if (!body.ok) return err(refused(tool, body.error));
  return stateAnswer(serving, { exchange, exact }, body.value ?? null, state);
};

/** The collection a create writes into: a linked plan's, only for its exemplar's path arguments, else the one the call's path selects. */
const writtenCollection = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<string | undefined, AnalysisError> => {
  const { tool, plan } = request;
  const linked = linkedCollection(plan, tool.path_template);
  if (linked === undefined)
    return ok(
      createdCollection(serving, tool, request.args, plan.target ?? ""),
    );
  const exemplar =
    plan.exemplar_ordinal === null
      ? undefined
      : serving.source.exchanges.get(plan.exemplar_ordinal);
  // No read showed where other path arguments create.
  return sameLinkedSource(tool.path_template, exemplar?.path, call.pathValues)
    ? ok(linked)
    : err(
        refused(
          tool,
          `Tool ${tool.name} creates into ${linked} only with the path arguments its recording sent.`,
        ),
      );
};

const answerCreate = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<StateAnswer, AnalysisError> => {
  const { tool, plan } = request;
  const type = plan.target ?? "";
  const idField = serving.store.type(type)?.id_field ?? "";
  const target = writtenCollection(serving, request, call);
  if (!target.ok) return target;
  const collection = target.value;
  const observed = observedEntity(serving, plan);
  if (collection === undefined || observed === undefined)
    return err(
      refused(
        tool,
        `Tool ${tool.name} needs every path argument to be non-empty.`,
      ),
    );
  if (plan.collection !== null && plan.collection !== collection)
    return err(
      refused(
        tool,
        `The recorded create's values are tied to ${plan.collection}; the environment models creates only there.`,
      ),
    );
  const members = serving.store.inCollection(type, collection);
  const values = generator(serving, request, {
    name: collection,
    collection: members,
    observed,
  });
  // The gate learned path rules from the recorded path, decoded; the collection is this call's.
  const created = {
    ...call,
    pathValues: pathValuesOf(tool.path_template, collection) ?? call.pathValues,
  };
  const fields = createdFields(plan, observed, created, values.generate);
  if (!fields.ok) return err(refused(tool, fields.error));
  const field = unloadableMember(fields.value);
  if (field !== undefined) return err(unloadable(tool, `Field ${field}`));
  const id = scalarText(fields.value[idField]);
  if (
    id === undefined ||
    serving.store.entity(type, collection, id) !== undefined
  )
    return err(
      refused(
        tool,
        `The state already holds a ${type} entity ${id ?? ""} in ${collection}.`,
      ),
    );
  const state = {
    source: "state",
    view: "create",
    type,
    collection,
    id,
  } as const;
  const answer = writeAnswer(
    serving,
    request,
    { fields: fields.value, id },
    state,
  );
  if (!answer.ok) return answer;
  const inserted = serving.store.insert(
    {
      type,
      collection,
      id,
      fields: fields.value,
      view_fields: [],
      record_ordinals: [],
    },
    insertIndex(
      plan.insert ?? { rule: "last" },
      members.map((entity) => entity.fields),
      fields.value,
    ),
  );
  if (!inserted.ok) return inserted;
  serving.store.commitWrite(values.taken);
  return answer;
};

/** The held entity an update or delete names, or the answer for one the state does not hold. */
const targetEntity = (
  serving: StateServing,
  request: WriteRequest,
): Result<StateEntity, Result<StateAnswer, AnalysisError>> => {
  const { tool, plan, args } = request;
  const call = itemCall(tool, args);
  if (call === undefined)
    return err(
      err(refused(tool, `Tool ${tool.name} needs every path argument.`)),
    );
  const entity = namedEntity(serving.store, plan.target ?? "", call);
  return entity === undefined
    ? err(
        missingAnswer(serving, tool, {
          type: plan.target ?? "",
          collection: `/${call.segments.map(({ text }) => text).join("/")}`,
          id: call.id,
        }),
      )
    : ok(entity);
};

const answerUpdate = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<StateAnswer, AnalysisError> => {
  const { tool, plan } = request;
  const target = targetEntity(serving, request);
  if (!target.ok) return target.error;
  const entity = target.value;
  const observed = observedEntity(serving, plan) ?? {};
  const values = generator(serving, request, {
    name: entity.collection,
    collection: serving.store.inCollection(entity.type, entity.collection),
    observed,
    current: entity.fields,
  });
  const written = updatedFields(
    plan,
    { before: entity.fields, observed },
    { ...call, id: entity.id },
    values.generate,
  );
  if (!written.ok) return err(refused(tool, written.error));
  // An increment can pass the exact integers.
  const field = unloadableMember(written.value);
  if (field !== undefined) return err(unloadable(tool, `Field ${field}`));
  const answer = writeAnswer(
    serving,
    request,
    { fields: written.value, id: entity.id },
    {
      source: "state",
      view: "update",
      type: entity.type,
      collection: entity.collection,
      id: entity.id,
    },
  );
  if (!answer.ok) return answer;
  const updated = serving.store.update(updatedEntity(entity, written.value));
  if (!updated.ok) return updated;
  serving.store.commitWrite(values.taken);
  return answer;
};

const answerDelete = (
  serving: StateServing,
  request: WriteRequest,
): Result<StateAnswer, AnalysisError> => {
  const target = targetEntity(serving, request);
  if (!target.ok) return target.error;
  const entity = target.value;
  const answer = writeAnswer(
    serving,
    request,
    { fields: entity.fields, id: entity.id },
    {
      source: "state",
      view: "delete",
      type: entity.type,
      collection: entity.collection,
      id: entity.id,
    },
  );
  if (answer.ok) {
    serving.store.remove(entity);
    serving.store.commitWrite(new Map());
  }
  return answer;
};

/** The held document a call changes: only at the path the state holds it, with members the capture sent as the JSON types the document holds. */
const documentTarget = (
  serving: StateServing,
  { tool, plan, args }: WriteRequest,
  call: WriteCall,
): Result<HeldDocument, AnalysisError> => {
  const held = serving.store.document(plan.target ?? "");
  const segments = callSegments(tool, args);
  if (held === undefined || plan.body === null)
    return err(
      refused(tool, `The state holds no document for ${plan.target ?? ""}.`),
    );
  if (segments === undefined)
    return err(refused(tool, `Tool ${tool.name} needs every path argument.`));
  // Document reads answer only on their recorded line, so a write elsewhere has no document to change.
  if (collectionMatch(held.path, segments) === undefined)
    return err(
      refused(
        tool,
        `The state holds this document only at ${held.path}; the environment models writes to it only there.`,
      ),
    );
  const initial = serving.store.state.documents.find(
    (document) => document.tool === held.tool,
  );
  const problem = documentBodyProblem(plan, call, {
    initial: initial?.value,
    current: held.value,
  });
  return problem === undefined ? ok(held) : err(refused(tool, problem));
};

const answerDocument = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<StateAnswer, AnalysisError> => {
  const { tool, plan } = request;
  const target = documentTarget(serving, request, call);
  if (!target.ok) return target;
  const held = target.value;
  const written = writtenDocument(plan, held.value, call);
  if (!written.ok) return err(refused(tool, written.error));
  if (!isLoadableValue(written.value))
    return err(unloadable(tool, "The document"));
  const state = {
    source: "state",
    view: "document-write",
    path: held.path,
  } as const;
  const answer =
    plan.response?.shape === "entity"
      ? (() => {
          const exchange = serving.source.exchanges.get(plan.response.ordinal);
          return exchange === undefined
            ? err(refused(tool, `Tool ${tool.name} has no recorded response.`))
            : stateAnswer(
                serving,
                { exchange, exact: true },
                written.value,
                state,
              );
        })()
      : writeAnswer(serving, request, { fields: undefined, id: "" }, state);
  if (!answer.ok) return answer;
  const set = serving.store.setDocument(held.tool, written.value);
  if (!set.ok) return set;
  serving.store.commitWrite(new Map());
  return answer;
};

/** Apply one served write tool call to the live state and answer it; a refused call leaves the state unchanged. */
export const answerWrite = (
  serving: StateServing,
  request: WriteRequest,
): Result<StateAnswer, AnalysisError> => {
  const body = callBody(request);
  if (!body.ok) return body;
  const call: WriteCall = {
    path: request.tool.path_template,
    pathValues: pathValues(request.tool, request.args),
    body: body.value,
  };
  switch (request.plan.effect) {
    case "create":
      return answerCreate(serving, request, call);
    case "update":
      return answerUpdate(serving, request, call);
    case "delete":
      return answerDelete(serving, request);
    case "document":
      return answerDocument(serving, request, call);
    case "none":
      return err(
        refused(
          request.tool,
          `Tool ${request.tool.name} is not served from the state.`,
        ),
      );
  }
};
