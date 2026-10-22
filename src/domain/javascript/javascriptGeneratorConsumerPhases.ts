import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  readExactJavaScriptNormalResult,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
  javaScriptExactResultOperand,
  semanticDirectFunctionResult,
  semanticValueWriteSite,
} from "./javascriptAstValues.js";
import {
  syntaxEvaluationCannotThrow,
  syntaxEvaluationAlwaysThrows,
  syntaxBeforeDefiniteThrow,
} from "./javascriptSymbolicControlFlow.js";
import {
  resolveSemanticBindingState,
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  semanticLiteralProjectionSlot,
  semanticLiteralRestSlots,
  semanticLiteralOwnKeysStable,
} from "./javascriptSemanticLiteralProjection.js";
import {
  semanticExpressionCannotThrow,
  semanticAssignmentTargetCompletion,
} from "./javascriptSemanticExpressionResults.js";
import {
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import { semanticExactValueIdentity } from "./javascriptSemanticPromiseIdentity.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  semanticPrototypeLookupMayChange,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";

interface PatternWaitCache {
  readonly effects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
  readonly ambientEffectCount: number;
  readonly iterationUnknown: boolean | undefined;
  readonly ownedResultEscape: t.Node | undefined;
  readonly normalContinuation: boolean;
  readonly completedCount: number;
  readonly inProgress: boolean;
  readonly index: number | null;
  readonly blockedIndex: number | null;
}

/** Fold completed consumer bindings without losing waits or borrowing past exits. */
export const semanticGeneratorBindingPhase = (
  read: t.Node,
  body: t.Node,
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
  bindingCompletion: (
    pattern: t.Node,
    value: t.Node | null,
  ) => PatternCompletion,
): PatternCompletion => {
  const facts = generatorPrefixes(body, ordered, maySuspend, state);
  const count = facts.before.get(read) ?? -1;
  let phase: PatternCompletion = "completed";
  for (const yielded of facts.yielded.slice(0, Math.max(0, count))) {
    phase = combinePatternCompletion(
      phase,
      bindingCompletion(pattern, yielded.argument ?? null),
    );
    if (patternStopped(phase)) break;
  }
  return phase;
};

interface GeneratorPrefixFacts {
  readonly effects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
  readonly phase: JavaScriptSemanticAnalysisState["memberMutationFactsPhase"];
  readonly before: WeakMap<t.Node, number>;
  readonly yielded: readonly t.YieldExpression[];
  readonly cleanup: WeakSet<t.Node>;
  readonly firstPatternWait: WeakMap<t.ArrayPattern, PatternWaitCache>;
}
const prefixes = new WeakMap<t.Node, GeneratorPrefixFacts>();

/** Index only straight-line owned yields; uncertain branches do not prove a resume phase. */
const generatorPrefixes = (
  body: t.Node,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
  state: JavaScriptSemanticAnalysisState,
): GeneratorPrefixFacts => {
  const cached = prefixes.get(body);
  if (
    cached !== undefined &&
    cached.effects === state.literalMemberEffects &&
    cached.phase === state.memberMutationFactsPhase
  )
    return cached;
  const before = new WeakMap<t.Node, number>();
  const yielded: t.YieldExpression[] = [];
  const cleanup = new WeakSet<t.Node>();
  let completed = 0;
  let failed = false;
  const pending: { node: t.Node; exit?: true; cleanup?: boolean }[] = [
    { node: body },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const node = unwrapJavaScriptExpression(entry.node).node;
    if (entry.cleanup) cleanup.add(node);
    if (entry.exit === true) {
      if (t.isYieldExpression(node)) {
        if (node.delegate) completed = -1;
        else if (
          node.argument != null &&
          syntaxEvaluationAlwaysThrows(node.argument)
        )
          failed = true;
        else if (completed >= 0) {
          yielded.push(node);
          completed += 1;
        }
      }
      continue;
    }
    before.set(node, failed && !entry.cleanup ? -1 : completed);
    if (failed && !entry.cleanup) continue;
    if (t.isFunction(node)) continue;
    if (
      (t.isIfStatement(node) ||
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node) ||
        t.isLoop(node) ||
        t.isSwitchStatement(node) ||
        (t.isTryStatement(node) &&
          !(
            node.handler == null &&
            node.block.body.every((statement) => {
              const expression = t.isExpressionStatement(statement)
                ? statement.expression
                : statement;
              return (
                syntaxEvaluationCannotThrow(expression) ||
                syntaxEvaluationAlwaysThrows(expression) ||
                (t.isYieldExpression(expression) &&
                  !expression.delegate &&
                  (expression.argument == null ||
                    syntaxEvaluationCannotThrow(expression.argument) ||
                    t.isIdentifier(patternValueNode(expression.argument)) ||
                    undefinedPatternValue(
                      { known: true, node: expression.argument },
                      state,
                    )))
              );
            })
          ))) &&
      maySuspend(node)
    )
      completed = -1;
    if (t.isYieldExpression(node)) pending.push({ node, exit: true });
    const children = ordered(node);
    for (const child of children.toReversed())
      pending.push({
        node: child,
        cleanup:
          entry.cleanup || (t.isTryStatement(node) && child === node.finalizer),
      });
  }
  const facts = {
    effects: state.literalMemberEffects,
    phase: state.memberMutationFactsPhase,
    before,
    yielded,
    cleanup,
    firstPatternWait: new WeakMap<t.ArrayPattern, PatternWaitCache>(),
  };
  prefixes.set(body, facts);
  return facts;
};

type PatternValue = {
  readonly known: boolean;
  readonly completionUnknown?: boolean;
  readonly node?: t.Node;
  readonly restStartIndex?: number;
  readonly ownedResultEscape?: t.Node;
};

/** Normal result selection is separate from whether its evaluation can finish. */
const patternValueNode = (raw: t.Node): t.Node => {
  let node = unwrapJavaScriptExpression(raw).node;
  for (;;) {
    const result = javaScriptExactResultOperand(
      node,
      undefined,
      syntaxEvaluationCannotThrow,
    );
    if (result === undefined) return node;
    node = unwrapJavaScriptExpression(result).node;
  }
};

/** Nullish aliases require the shared identity and initialization proofs. */
const patternNullishNode = (
  raw: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): t.Node => {
  const node = patternValueNode(raw);
  if (!t.isIdentifier(node) || executionFrames === undefined) return node;
  const exact = semanticExactValueIdentity(node, state);
  if (exact === undefined) return node;
  const literal = readExactJavaScriptNormalResult(
    exact.node,
    syntaxEvaluationCannotThrow,
  );
  if (
    !(
      t.isNullLiteral(exact.node) ||
      isUnshadowedGlobal(exact.node, state, "undefined") ||
      (literal.found && literal.value === undefined)
    ) ||
    !exact.aliases.every(
      ({ initializer, read }) =>
        semanticInitializerPrecedesRead({
          initializer: initializer.node,
          read,
          ...(initializer.bindingNode === undefined
            ? {}
            : { bindingNode: initializer.bindingNode }),
          parents: state.parentsByNode,
          initializerContexts: executionFrames(initializer.node),
          readContexts: executionFrames(read),
        }) === true,
    )
  )
    return node;
  return exact.node;
};

const undefinedPatternValue = (
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  if (!value.known) return false;
  const argument =
    value.node === undefined
      ? undefined
      : patternNullishNode(value.node, state, executionFrames);
  if (
    argument === undefined ||
    isUnshadowedGlobal(argument, state, "undefined")
  )
    return true;
  const result = readExactJavaScriptNormalResult(
    argument,
    syntaxEvaluationCannotThrow,
  );
  return result.found && result.value === undefined;
};

/** Both object coercion and iterator acquisition reject nullish slot values. */
const nullishPatternValue = (
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  if (!value.known) return false;
  if (value.node === undefined) return true;
  const node = patternNullishNode(value.node, state, executionFrames);
  return (
    t.isNullLiteral(node) || undefinedPatternValue({ ...value, node }, state)
  );
};

/** A string's native iterator cannot be credited after a visible lookup change. */
const patternStringIterationIntact = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  state.memberMutationFactsPhase ??= "requested";
  const prefix = ["global", "String", "prototype"];
  return !state.ambientReferenceEffects.some(({ path, node }) => {
    if (
      !path
        .slice(0, prefix.length)
        .every((key, index) =>
          semanticPropertyPathKeyMatches(key, prefix[index] ?? ""),
        )
    )
      return false;
    if (
      path.length > prefix.length &&
      !semanticPrototypeLookupMayChange(path.slice(prefix.length), "@@iterator")
    )
      return false;
    if (semanticEffectTiming(capture, node, state) === "after") return false;
    const frames =
      executionFrames?.(capture).filter(
        ({ owner }) => owner === state.program,
      ) ?? [];
    return (
      frames.length === 0 ||
      !frames.every(
        ({ point }) => semanticEffectTiming(point, node, state) === "after",
      )
    );
  });
};

/** Proven primitive failures and an own null prototype cannot acquire an iterator. */
const noniterablePatternValue = (
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
  capture: t.Node,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  if (nullishPatternValue(value, state, executionFrames)) return true;
  if (!value.known || value.node === undefined) return false;
  const node = patternValueNode(value.node);
  const literal = readExactJavaScriptLiteral(node);
  const bigint =
    t.isBigIntLiteral(node) ||
    (t.isUnaryExpression(node, { operator: "-" }) &&
      t.isBigIntLiteral(node.argument));
  if (literal.found || bigint) {
    const boxed =
      !bigint && literal.found && typeof literal.value === "number"
        ? "Number"
        : !bigint && literal.found && typeof literal.value === "boolean"
          ? "Boolean"
          : "BigInt";
    return (
      (bigint || (literal.found && typeof literal.value !== "string")) &&
      [boxed, "Object"].every(
        (name) =>
          !state.ambientWrites.covers(["global", name, "prototype", null]) &&
          !state.ambientEscapes.covers(["global", name, "prototype", null]),
      )
    );
  }
  return (
    t.isObjectExpression(node) &&
    node.properties.every(
      (property) =>
        !t.isSpreadElement(property) &&
        semanticStaticPropertyKey(property.key, property.computed) !== null,
    ) &&
    semanticLiteralOwnKeysStable(
      node,
      capture,
      state,
      value.ownedResultEscape,
    ) &&
    (() => {
      const prototype = node.properties.find(
        (property) =>
          t.isObjectProperty(property) &&
          !property.computed &&
          !property.shorthand &&
          semanticStaticPropertyKey(property.key, false) === "__proto__",
      );
      return prototype === undefined
        ? !state.ambientWrites.covers([
            "global",
            "Object",
            "prototype",
            null,
          ]) &&
            !state.ambientEscapes.covers([
              "global",
              "Object",
              "prototype",
              null,
            ])
        : t.isObjectProperty(prototype) && t.isNullLiteral(prototype.value);
    })()
  );
};

/** Shared iterator acquisition failure for nested patterns and loop consumers. */
export const semanticIteratorAcquisitionAlwaysFails = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  syntaxEvaluationAlwaysThrows(node) ||
  noniterablePatternValue({ known: true, node }, state, node);

/** Use the same mutation and iterator proof as ordinary literal projections. */
const patternPropertyValue = (
  value: PatternValue,
  key: string | number,
  state: JavaScriptSemanticAnalysisState,
  capture: t.Node,
): PatternValue => {
  if (!value.known || value.node === undefined) return { known: false };
  const node = patternValueNode(value.node);
  // A fresh rest array has suffix-relative own indices. Object property reads
  // beyond its length still consult its prototype, unlike iterator exhaustion.
  const restIndex =
    value.restStartIndex === undefined ? null : semanticArrayIndex(key);
  if (value.restStartIndex !== undefined && restIndex === null)
    return { known: false };
  if (
    value.restStartIndex !== undefined &&
    typeof key === "string" &&
    restIndex !== null &&
    t.isArrayExpression(node) &&
    restIndex >= Math.max(0, node.elements.length - value.restStartIndex) &&
    ["Array", "Object"].some(
      (name) =>
        state.ambientWrites.covers(["global", name, "prototype", key]) ||
        state.ambientEscapes.covers(["global", name, "prototype", key]) ||
        state.ambientWrites.covers([
          "global",
          name,
          "prototype",
          "__proto__",
        ]) ||
        state.ambientEscapes.covers(["global", name, "prototype", "__proto__"]),
    )
  )
    return { known: false };
  const selected = semanticLiteralProjectionSlot(
    node,
    value.restStartIndex !== undefined && restIndex !== null
      ? restIndex + value.restStartIndex
      : key,
    capture,
    state,
    value.ownedResultEscape === undefined
      ? undefined
      : { ownedResultEscape: value.ownedResultEscape },
  );
  if (selected.kind === "value")
    return {
      known: true,
      node: selected.node,
      ...(value.ownedResultEscape === undefined
        ? {}
        : { ownedResultEscape: value.ownedResultEscape }),
    };
  if (selected.kind === "undefined") return { known: true };
  if (selected.kind === "accessor") {
    return patternAccessorValue(selected.node, state);
  }
  if (selected.kind === "invalid")
    return { known: false, completionUnknown: true };
  return { known: false };
};

/** A completed undefined getter result is not an unsupported accessor body. */
const patternAccessorValue = (
  node: t.ObjectMethod,
  state: JavaScriptSemanticAnalysisState,
): PatternValue => {
  const result = semanticDirectFunctionResult(node);
  if (result.kind === "undefined") return { known: true };
  return result.kind === "value" &&
    (syntaxEvaluationCannotThrow(result.node) ||
      isUnshadowedGlobal(
        unwrapJavaScriptExpression(result.node).node,
        state,
        "undefined",
      ))
    ? { known: true, node: result.node }
    : { known: false, completionUnknown: true };
};

/** A rest copy owns a fresh suffix array; retain indices without synthesizing AST. */
const patternArrayRest = (
  value: PatternValue,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): PatternValue => {
  const node =
    value.node === undefined ? undefined : patternValueNode(value.node);
  return value.known &&
    t.isArrayExpression(node) &&
    state.arrayIterationUnknown !== true &&
    !node.elements.some((item) => t.isSpreadElement(item))
    ? {
        known: true,
        node,
        restStartIndex: (value.restStartIndex ?? 0) + index,
        ...(value.ownedResultEscape === undefined
          ? {}
          : { ownedResultEscape: value.ownedResultEscape }),
      }
    : { known: false };
};

type PatternCompletion =
  | "completed"
  | "suspended"
  | "blocked"
  | "suspended-blocked"
  | "unproven"
  | "suspended-unproven";
const patternSuspended = (phase: PatternCompletion): boolean =>
  phase === "suspended" ||
  phase === "suspended-blocked" ||
  phase === "suspended-unproven";
const patternStopped = (phase: PatternCompletion): boolean =>
  phase !== "completed" && phase !== "suspended";
const combinePatternCompletion = (
  before: PatternCompletion,
  after: PatternCompletion,
): PatternCompletion => {
  if (patternStopped(before)) return before;
  if (!patternSuspended(before) || patternSuspended(after)) return after;
  return after === "blocked"
    ? "suspended-blocked"
    : after === "unproven"
      ? "suspended-unproven"
      : "suspended";
};
const patternExpressionCompletion = (
  node: t.Node,
  suspended: (node: t.Node) => boolean,
): PatternCompletion =>
  syntaxEvaluationAlwaysThrows(node)
    ? syntaxBeforeDefiniteThrow(node).some(suspended)
      ? "suspended-blocked"
      : "blocked"
    : suspended(node)
      ? "suspended"
      : "completed";

/** Work completed inside a consumed slot precedes the next generator resume. */
const patternCompletedSuspension = (
  pattern: t.Node,
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
  suspended: (node: t.Node) => boolean,
  depth = 0,
  target?: t.Node,
  targetPath?: ReadonlySet<t.Node>,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
  normalContinuation = false,
): PatternCompletion => {
  if (depth >= 128 || value.completionUnknown) return "unproven";
  if (pattern === target)
    return patternExpressionCompletion(pattern, suspended);
  if (t.isAssignmentPattern(pattern)) {
    const selectsDefault = undefinedPatternValue(value, state, executionFrames);
    // Optional default selection does not establish a required wait. A normal
    // next-step query may still inspect later mandatory work; cleanup/getter
    // entry does not itself prove that this earlier binding completed.
    if (!value.known && suspended(pattern.right) && !normalContinuation)
      return "unproven";
    const prefix = selectsDefault
      ? patternExpressionCompletion(pattern.right, suspended)
      : "completed";
    if (patternStopped(prefix)) return prefix;
    return combinePatternCompletion(
      prefix,
      patternCompletedSuspension(
        pattern.left,
        selectsDefault ? { known: true, node: pattern.right } : value,
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
        executionFrames,
        normalContinuation,
      ),
    );
  }
  let phase: PatternCompletion = "completed";
  if (t.isObjectPattern(pattern)) {
    // RequireObjectCoercible precedes property keys and rest operations.
    // A definite failure also blocks waits in later consumed slots.
    if (nullishPatternValue(value, state, executionFrames)) return "blocked";
    const excluded = new Set<string>();
    let unknownExclusion = false;
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) {
        // Rest evaluates its target reference, then copies remaining own values,
        // and only afterwards performs PutValue (which may invoke a setter).
        phase = combinePatternCompletion(
          phase,
          patternExpressionCompletion(property.argument, suspended),
        );
        if (patternStopped(phase)) return phase;
        // The target reference precedes copying; the selected getter and
        // assignment of the rest result have not run at this entry point.
        if (property === target) return phase;
        const slots =
          value.known && value.node !== undefined && !unknownExclusion
            ? semanticLiteralRestSlots(
                patternValueNode(value.node),
                excluded,
                property,
                state,
                value.ownedResultEscape,
              )
            : undefined;
        if (
          slots === undefined ||
          slots.some(
            (slot) =>
              slot.kind === "unknown" ||
              slot.kind === "invalid" ||
              (slot.kind === "accessor" &&
                patternAccessorValue(slot.node, state).completionUnknown),
          )
        )
          return combinePatternCompletion(phase, "unproven");
        phase = combinePatternCompletion(
          phase,
          patternCompletedSuspension(
            property.argument,
            { known: false },
            state,
            suspended,
            depth + 1,
            target,
            targetPath,
            executionFrames,
            normalContinuation,
          ),
        );
        if (patternStopped(phase) || targetPath?.has(property)) return phase;
        continue;
      }
      if (property.computed)
        phase = combinePatternCompletion(
          phase,
          patternExpressionCompletion(property.key, suspended),
        );
      if (patternStopped(phase)) return phase;
      // A selected getter is entered after this key, before Get/default/value work.
      if (property === target) return phase;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (key === null) unknownExclusion = true;
      else excluded.add(String(key));
      const completion = patternCompletedSuspension(
        property.value,
        key === null
          ? { known: false }
          : patternPropertyValue(value, key, state, pattern),
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
        executionFrames,
        normalContinuation,
      );
      phase = combinePatternCompletion(phase, completion);
      if (patternStopped(phase)) return phase;
      if (targetPath?.has(property)) return phase;
    }
  }
  if (t.isArrayPattern(pattern)) {
    // GetIterator runs even for an empty pattern, before later slots/defaults.
    if (noniterablePatternValue(value, state, pattern, executionFrames))
      return "blocked";
    if (value.known && value.node !== undefined) {
      const iterable = patternValueNode(value.node);
      const literal = readExactJavaScriptLiteral(iterable);
      // GetIterator runs even for [] and may throw before any slot can be
      // projected. An invalid iterator is not a completed unknown value.
      if (t.isArrayExpression(iterable) && state.arrayIterationUnknown)
        return "unproven";
      if (
        literal.found &&
        typeof literal.value === "string" &&
        !patternStringIterationIntact(pattern, state, executionFrames)
      )
        return "unproven";
      // A visible boxed-primitive iterator prevents a definite acquisition
      // failure, but does not prove that its hooks complete before cleanup.
      if (
        (literal.found && typeof literal.value !== "string") ||
        t.isBigIntLiteral(iterable) ||
        (t.isUnaryExpression(iterable, { operator: "-" }) &&
          t.isBigIntLiteral(iterable.argument))
      )
        return "unproven";
    }
    for (const [index, element] of pattern.elements.entries()) {
      if (element === null) continue;
      const completion = patternCompletedSuspension(
        t.isRestElement(element) ? element.argument : element,
        t.isRestElement(element)
          ? patternArrayRest(value, index, state)
          : patternPropertyValue(value, index, state, pattern),
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
        executionFrames,
        normalContinuation,
      );
      phase = combinePatternCompletion(phase, completion);
      if (patternStopped(phase)) return phase;
      if (targetPath?.has(element)) return phase;
    }
  }
  if (t.isIdentifier(pattern) || t.isMemberExpression(pattern)) {
    if (t.isMemberExpression(pattern))
      phase = combinePatternCompletion(
        phase,
        patternExpressionCompletion(pattern, suspended),
      );
    if (patternStopped(phase)) return phase;
    // Classify target roles once: loop assignments write existing bindings;
    // declarations and catch/function parameters initialize fresh bindings.
    const owner = semanticValueWriteSite(pattern, state.parentsByNode);
    if (
      t.isAssignmentExpression(owner) ||
      t.isForOfStatement(owner) ||
      t.isForInStatement(owner)
    ) {
      const completion = semanticAssignmentTargetCompletion(
        pattern,
        pattern,
        state,
        executionFrames,
      );
      if (completion !== "completed")
        return combinePatternCompletion(
          phase,
          completion === "abrupt" ? "blocked" : "unproven",
        );
    }
  }
  return phase;
};

/** Binding consumers share coercion, selected defaults and completed target work.
 * A null input is known undefined (a bare yield); undefined is an unknown input.
 */
export const semanticPatternCompletion = (
  pattern: t.Node,
  value: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
  suspended: (node: t.Node) => boolean,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
  ownedResultEscape?: t.Node,
  normalContinuation = false,
): PatternCompletion =>
  patternCompletedSuspension(
    pattern,
    value === undefined
      ? { known: false }
      : {
          known: true,
          ...(value === null ? {} : { node: value }),
          ...(ownedResultEscape === undefined ? {} : { ownedResultEscape }),
        },
    state,
    suspended,
    0,
    undefined,
    undefined,
    executionFrames,
    normalContinuation,
  );

/** Selected defaults and keys before a particular destructuring write share slot semantics. */
export const semanticPatternCompletionBeforeTarget = (
  pattern: t.Node,
  value: t.Node,
  target: t.Node,
  state: JavaScriptSemanticAnalysisState,
  completedSuspension: (node: t.Node) => boolean,
  executionFrames?: (node: t.Node) => readonly SemanticExecutionFrame[],
): PatternCompletion => {
  const path = new Set<t.Node>();
  let current: t.Node | undefined = target;
  while (current !== undefined) {
    path.add(current);
    if (current === pattern)
      return combinePatternCompletion(
        patternExpressionCompletion(value, completedSuspension),
        patternCompletedSuspension(
          pattern,
          { known: true, node: value },
          state,
          completedSuspension,
          0,
          target,
          path,
          executionFrames,
        ),
      );
    current = state.parentsByNode.get(current);
  }
  return "unproven";
};

export const semanticPatternSuspendsBeforeTarget = (
  ...args: Parameters<typeof semanticPatternCompletionBeforeTarget>
): boolean => semanticPatternCompletionBeforeTarget(...args) === "suspended";

/** Only completed work in an earlier consumed slot can delay the next iterator step. */
export const semanticPatternSuspendsBeforeGeneratorRead = ({
  read,
  body,
  pattern,
  state,
  ordered,
  maySuspend,
  completedSuspension,
  ownedResultEscape,
  executionFrames,
}: {
  readonly read: t.Node;
  readonly body: t.Node;
  readonly pattern: t.ArrayPattern;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly ordered: (node: t.Node) => readonly t.Node[];
  readonly maySuspend: (node: t.Node) => boolean;
  readonly completedSuspension: (node: t.Node) => boolean;
  readonly ownedResultEscape?: t.Node;
  readonly executionFrames?: (
    node: t.Node,
  ) => readonly SemanticExecutionFrame[];
}): boolean => {
  // Pattern continuation depends on iterator and mutation facts even when its
  // initial constructor-order query cannot yet establish a candidate endpoint.
  state.memberMutationFactsPhase ??= "requested";
  const facts = generatorPrefixes(body, ordered, maySuspend, state);
  const count = facts.before.get(unwrapJavaScriptExpression(read).node);
  // No binding work has run while evaluating the first yielded value. Avoid
  // asking that binding's value proof to establish its own read context.
  if (count === undefined || count <= 0) return false;
  const cleanup = facts.cleanup.has(read);
  // A finite pattern closes its iterator after its last slot, not another next().
  if (
    !cleanup &&
    count >= pattern.elements.length &&
    !pattern.elements.some((element) => t.isRestElement(element))
  )
    return false;
  const waited = (index: number | null, blockedIndex: number | null): boolean =>
    index !== null &&
    index < count &&
    (cleanup || blockedIndex === null || blockedIndex >= count);
  const candidate = facts.firstPatternWait.get(pattern);
  const cached =
    candidate !== undefined &&
    candidate.effects === state.literalMemberEffects &&
    candidate.ambientEffectCount === state.ambientReferenceEffects.length &&
    candidate.iterationUnknown === state.arrayIterationUnknown &&
    candidate.ownedResultEscape === ownedResultEscape &&
    candidate.normalContinuation === !cleanup
      ? candidate
      : undefined;
  if (
    cached !== undefined &&
    (cached.completedCount >= count || cached.blockedIndex !== null)
  )
    return waited(cached.index, cached.blockedIndex);
  // A cyclic context query cannot borrow work from a slot still being proved.
  if (cached?.inProgress) return false;
  let firstWait: number | null = cached?.index ?? null;
  let blockedAt: number | null = cached?.blockedIndex ?? null;
  let completedCount = cached?.completedCount ?? 0;
  const cache = (inProgress: boolean): void => {
    facts.firstPatternWait.set(pattern, {
      effects: state.literalMemberEffects,
      ambientEffectCount: state.ambientReferenceEffects.length,
      iterationUnknown: state.arrayIterationUnknown,
      ownedResultEscape,
      normalContinuation: !cleanup,
      completedCount,
      inProgress,
      index: firstWait,
      blockedIndex: blockedAt,
    });
  };
  // A yielded value is evaluated before its slot is bound. Inspect only slots
  // completed before this read's resume: asking a later slot about an alias
  // must not ask that alias to establish its own consumer timing. Recursive
  // read-context queries therefore examine a strictly earlier yield prefix.
  cache(true);
  try {
    for (
      let index = completedCount;
      index < Math.min(count, pattern.elements.length);
      index += 1
    ) {
      const element = pattern.elements[index];
      if (t.isRestElement(element)) break;
      if (element == null) continue;
      const yielded = facts.yielded[index];
      if (yielded === undefined) break;
      const argument =
        yielded.argument == null
          ? undefined
          : patternValueNode(yielded.argument);
      // A slot cannot bind, or lend its wait, before its yielded value completes.
      // Preserve already settled slots so an abrupt later yield can still close
      // the iterator after an earlier binding suspension.
      if (
        t.isIdentifier(argument) &&
        !isUnshadowedGlobal(argument, state, "undefined") &&
        !semanticExpressionCannotThrow(argument, state, executionFrames)
      ) {
        blockedAt = index;
        break;
      }
      const completion = patternCompletedSuspension(
        element,
        {
          known: true,
          ...(yielded.argument == null ? {} : { node: yielded.argument }),
          ...(ownedResultEscape === undefined ? {} : { ownedResultEscape }),
        },
        state,
        completedSuspension,
        0,
        undefined,
        undefined,
        executionFrames,
        !cleanup,
      );
      if (patternSuspended(completion)) firstWait ??= index;
      completedCount = index + 1;
      if (patternStopped(completion)) {
        blockedAt = index;
        break;
      }
      // Later alias reads can reuse this settled prefix without rescanning it.
      cache(true);
    }
  } finally {
    cache(false);
  }
  return waited(firstWait, blockedAt);
};

/** A consumer phase can defer a body read only after an owned yield was reached. */
export const semanticGeneratorReadAfterYield = (
  read: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
): boolean =>
  (generatorPrefixes(body, ordered, maySuspend, state).before.get(read) ?? -1) >
  0;

/** IteratorClose enters finally without requesting another ordinary body step. */
export const semanticGeneratorReadInCleanup = (
  read: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
): boolean =>
  generatorPrefixes(body, ordered, maySuspend, state).cleanup.has(read);
