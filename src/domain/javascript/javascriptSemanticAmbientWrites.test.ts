import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import {
  indexJavaScriptBindingsSteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

it("retains opaque escapes in the canonical ordered ambient effect stream", () => {
  const parsed = parseJavaScriptSource(
    "const root=globalThis;mutate(root);",
    "app.cjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      parsed.program,
      "commonjs-wrapper",
    ),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  expect(
    index.bindings.ambientReferenceEffects.some(
      (effect) => effect.kind === "escape" && effect.path[0] === "global",
    ),
  ).toBe(true);
});

it("keeps promise constructor and then mutations as distinct producer paths", () => {
  const parsed = parseJavaScriptSource(
    'export {};const pending=import("ws");pending.then=()=>{};pending.constructor={};',
    "app.mjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const binding = [...index.bindings.bindingsById.values()].find(
    (binding) => binding.name === "pending",
  );
  expect(binding?.memberWrites.map((effect) => effect.path).sort()).toEqual([
    ["constructor"],
    ["then"],
  ]);
});

it("collects stored callback call sites once during definitions", () => {
  const parsed = parseJavaScriptSource(
    "const run=()=>0;run();const alias=run;alias();",
    "app.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  expect(state.callSites).toHaveLength(2);
  expect(new Set(state.callSites).size).toBe(2);
});

it("keeps wrapper module aliases distinct from global-object module properties", () => {
  const parsed = parseJavaScriptSource(
    `
    const wrapper = module;
    Object.defineProperty(wrapper, "exports", { value: exports });
    Object.defineProperty(globalThis.module, "exports", { value: exports });
  `,
    "app.cjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  expect(
    state.ambientReferenceEffects
      .filter(({ kind }) => kind === "write")
      .map(({ path }) => path),
  ).toEqual([
    ["commonjs-module", "exports"],
    ["global", "module", "exports"],
  ]);
});

it.each([
  ["const copy={...module};consume(copy);", false],
  ["const copy={...{child:module}};consume(copy);", true],
  [
    "const original={child:module};const copy={...original};consume(copy);",
    true,
  ],
])(
  "exposes copied children without escaping the source container: %s",
  (body, moduleEscaped) => {
    const parsed = parseJavaScriptSource(`function copy(){${body}}`);
    if (parsed === null) throw new Error("Expected copied escape fixture");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    expect(
      state.ambientReferenceEffects.some(
        ({ path, kind }) =>
          kind === "escape" &&
          path.length === 2 &&
          path[0] === "commonjs-module" &&
          path[1] === null,
      ),
    ).toBe(moduleEscaped);
  },
);

it.each([
  {
    name: "reconverging projections with different alias-cycle histories",
    setup: `var x; const a = { foo: x, bar: globalThis }; x = a.bar;
const y = flag ? x : a.foo; y.URL = replacement;`,
    specifier: null,
  },
  {
    name: "growing self-reference projections with an ambient initializer",
    setup: `let alias = globalThis; alias = alias.globalThis;
alias.URL = replacement;`,
    specifier: null,
  },
  {
    name: "distinct properties selecting both ambient identities",
    setup: `const box = { left: globalThis, right: import.meta };
const selected = flag ? box.left : box.right; selected.URL = replacement;`,
    specifier: null,
  },
  {
    name: "cyclic containers with a reachable ambient property",
    setup: `var alias; const box = { next: alias, target: import.meta };
alias = box; const selected = flag ? alias.target : alias.next.target;
selected.url = "file:///other/entry.mjs";`,
    specifier: null,
  },
  {
    name: "cycles containing no ambient identity",
    setup: `var box; box = { next: box };
const selected = flag ? box : box.next; selected.URL = replacement;`,
    specifier: "./worker.js",
  },
  {
    name: "unrelated writes through widened self-reference projections",
    setup: `let alias = globalThis; alias = alias.globalThis;
alias.unrelated = replacement;`,
    specifier: "./worker.js",
  },
  {
    name: "an exact empty projection into a shallow copy",
    setup: `const copy = { ...globalThis };
const selected = flag ? copy : copy; selected.URL = replacement;`,
    specifier: "./worker.js",
  },
])("preserves $name", ({ setup, specifier }) => {
  const source = `import { Worker } from "node:worker_threads";
${setup}
new Worker(new URL("./worker.js", import.meta.url));`;
  const worker = analyzeJavaScriptStaticSource(source).references.find(
    (reference) => reference.kind === "worker",
  );
  expect(worker?.specifier).toBe(specifier);
});
