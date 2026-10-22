import type { StateRecordFacts } from "./environmentStateRules.js";

/** Two recordings of a type that disagree across a write. */
export interface RewriteSpan {
  readonly type: string;
  readonly earlier: number;
  readonly later: number;
}

/**
 * Per type whose reads disagree across writes, the earliest write within any such span: one that
 * began before the later recording ended and ended after the earlier began, in timeline order.
 */
export const rewriteCuts = (
  spans: readonly RewriteSpan[],
  writes: readonly StateRecordFacts[],
  byOrdinal: ReadonlyMap<number, StateRecordFacts>,
): Map<string, StateRecordFacts> => {
  const cuts = new Map<string, number>();
  for (const span of spans) {
    const earlier = byOrdinal.get(span.earlier);
    const later = byOrdinal.get(span.later);
    if (earlier === undefined || later === undefined) continue;
    const index = writes.findIndex(
      (write) => write.start < later.end && write.end > earlier.start,
    );
    if (index !== -1)
      cuts.set(span.type, Math.min(index, cuts.get(span.type) ?? index));
  }
  return new Map([...cuts].map(([type, index]) => [type, writes[index]!]));
};
