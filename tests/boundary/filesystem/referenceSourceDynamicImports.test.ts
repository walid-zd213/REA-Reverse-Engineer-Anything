import { mkdir, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("resolves dynamic source imports while retaining computed targets as unknown", async () => {
  const root = await createTestTempDirectory("rea-reference-dynamic-import-");
  await Promise.all([
    writeFile(
      join(root, "main.ts"),
      [
        'import "./static";',
        'require("./common");',
        'const lazy = import("./lazy");',
        'async function load() { return await import("./data.json", { with: { type: "json" } }); }',
        'const name = "./not-guessed.js"; import(name);',
        "import(`./${name}.js`);",
        'import("node:fs");',
      ].join("\n"),
    ),
    ...["static.ts", "common.js", "lazy.ts"].map((path) =>
      writeFile(join(root, path), "export {};\n"),
    ),
    writeFile(join(root, "data.json"), '{"value":1}\n'),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-dynamic-import-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(6);
  for (const [to, kind] of [
    ["static.ts", "imports"],
    ["common.js", "requires"],
    ["lazy.ts", "imports"],
    ["data.json", "imports"],
  ])
    expect(result.value.relationships).toContainEqual({
      from_path: "main.ts",
      to,
      kind,
      resolution: "internal",
      parse_state: "parsed",
    });
  expect(result.value.relationships).toContainEqual({
    from_path: "main.ts",
    to: "<dynamic-import>",
    kind: "imports",
    resolution: "unknown",
    parse_state: "partial",
  });
  expect(result.value.relationships).toContainEqual({
    from_path: "main.ts",
    to: "node:fs",
    kind: "imports",
    resolution: "external",
    parse_state: "parsed",
  });
});

it("loads an extensionless JSON target only through CommonJS require", async () => {
  const root = await createTestTempDirectory("rea-reference-json-require-");
  await Promise.all([
    writeFile(join(root, "main.cjs"), 'require("./data");\n'),
    writeFile(join(root, "main.mjs"), 'import "./data";\n'),
    writeFile(join(root, "data.json"), '{"value":1}\n'),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-json-require-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  // ESM, unlike the CommonJS loader, requires the explicit `.json` extension.
  expect(result.value.relationships).toEqual([
    {
      from_path: "main.cjs",
      to: "data.json",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "main.mjs",
      to: "data",
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    },
  ]);
  expect(
    result.value.entries.map((entry) => [
      entry.path,
      "content_state" in entry ? entry.content_state : null,
    ]),
  ).toEqual([
    ["data.json", "hashed"],
    ["main.cjs", "hashed"],
    ["main.mjs", "hashed"],
  ]);
});

it("resolves percent-escaped ESM filenames once without changing CommonJS paths", async () => {
  const root = await createTestTempDirectory("rea-reference-esm-escaped-");
  await Promise.all([
    writeFile(
      join(root, "main.mjs"),
      [
        'import "./dep%20name.mjs";',
        'import "./dep%2520name.mjs";',
        'import "./caf%C3%A9.mjs";',
        'import "./missing%20name.mjs";',
      ].join("\n"),
    ),
    writeFile(join(root, "main.cjs"), 'require("./dep%20name.mjs");\n'),
    ...[
      "dep name.mjs",
      "dep%20name.mjs",
      "dep%2520name.mjs",
      "café.mjs",
      "missing%20name.mjs",
    ].map((path) => writeFile(join(root, path), "export {};\n")),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-escaped-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(5);
  for (const relationship of [
    {
      from_path: "main.cjs",
      to: "dep%20name.mjs",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    ...[
      ["dep name.mjs", "internal"],
      ["dep%20name.mjs", "internal"],
      ["café.mjs", "internal"],
      ["missing name.mjs", "unresolved"],
    ].map(([to, resolution]) => ({
      from_path: "main.mjs",
      to,
      kind: "imports",
      resolution,
      parse_state: "parsed",
    })),
  ])
    expect(result.value.relationships).toContainEqual(relationship);
  const entryPaths = result.value.entries.map(({ path }) => path);
  expect(entryPaths).toHaveLength(7);
  for (const path of [
    "café.mjs",
    "dep name.mjs",
    "dep%20name.mjs",
    "dep%2520name.mjs",
    "main.cjs",
    "main.mjs",
    "missing%20name.mjs",
  ])
    expect(entryPaths).toContain(path);
});

it("does not map invalid ESM URL pathnames to literal percent filenames", async () => {
  const root = await createTestTempDirectory("rea-reference-esm-invalid-");
  const filenames = [
    "bad%zz.mjs",
    "slash%2fname.mjs",
    "backslash%5cname.mjs",
    "nul%00name.mjs",
  ];
  await Promise.all([
    writeFile(
      join(root, "main.mjs"),
      filenames.map((name) => `import "./${name}";`).join("\n"),
    ),
    ...filenames.map((name) => writeFile(join(root, name), "export {};\n")),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-invalid-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(filenames.length);
  for (const name of filenames)
    expect(result.value.relationships).toContainEqual({
      from_path: "main.mjs",
      to: `./${name}`,
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    });
});

it.skipIf(process.platform === "win32")(
  "rejects an encoded backslash even when a POSIX backslash filename exists",
  async () => {
    const root = await createTestTempDirectory("rea-reference-esm-backslash-");
    await Promise.all([
      writeFile(join(root, "main.mjs"), 'import "./backslash%5cname.mjs";\n'),
      writeFile(join(root, "backslash\\name.mjs"), "export {};\n"),
      writeFile(join(root, "backslash%5cname.mjs"), "export {};\n"),
    ]);

    const result = await importReferenceSource({
      root,
      caller: "reference-esm-backslash-test",
      policy: { secretPatterns: [] },
    });
    if (!result.ok) throw result.error;
    expect(result.value.parse_failures).toEqual([]);
    expect(result.value.relationships).toContainEqual({
      from_path: "main.mjs",
      to: "./backslash%5cname.mjs",
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    });
  },
);

it("keeps TypeScript source imports as literal percent filenames", async () => {
  const root = await createTestTempDirectory("rea-reference-ts-percent-");
  await Promise.all([
    writeFile(join(root, "main.ts"), 'import "./dep%20name.js";\n'),
    writeFile(join(root, "main.mts"), 'import "./dep%20name.mjs";\n'),
    ...["ts", "mts"].flatMap((extension) =>
      ["dep name", "dep%20name"].map((name) =>
        writeFile(join(root, `${name}.${extension}`), "export {};\n"),
      ),
    ),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-ts-percent-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(2);
  for (const [from_path, to] of [
    ["main.ts", "dep%20name.ts"],
    ["main.mts", "dep%20name.mts"],
  ])
    expect(result.value.relationships).toContainEqual({
      from_path,
      to,
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    });
});

it("resolves ESM imports using the pathname before query and fragment suffixes", async () => {
  const root = await createTestTempDirectory("rea-reference-esm-suffix-");
  await Promise.all([
    writeFile(
      join(root, "main.mjs"),
      [
        'import "./dep.mjs?tag=%20";',
        'import "./dep.mjs?tag=second";',
        'import "./dep%20name.mjs?cache=1#v2";',
        'import "./slash-query.mjs?tag=%2f";',
        'import "./hash%23name.mjs?tag=x";',
      ].join("\n"),
    ),
    ...[
      "dep.mjs",
      "dep name.mjs",
      "slash-query.mjs",
      "hash#name.mjs",
      "hash%23name.mjs",
    ].map((path) => writeFile(join(root, path), "export {};\n")),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-suffix-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(4);
  for (const to of [
    "dep.mjs",
    "dep name.mjs",
    "slash-query.mjs",
    "hash#name.mjs",
  ])
    expect(result.value.relationships).toContainEqual({
      from_path: "main.mjs",
      to,
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    });
});

it.skipIf(process.platform === "win32")(
  "does not select POSIX filenames that contain ESM URL suffixes",
  async () => {
    const root = await createTestTempDirectory(
      "rea-reference-esm-suffix-decoy-",
    );
    await Promise.all([
      writeFile(
        join(root, "main.mjs"),
        'import "./dep.mjs?tag=%20";\nimport "./fragment.mjs#rev";\n',
      ),
      ...["dep.mjs", "fragment.mjs", "dep.mjs?tag= ", "fragment.mjs#rev"].map(
        (path) => writeFile(join(root, path), "export {};\n"),
      ),
    ]);

    const result = await importReferenceSource({
      root,
      caller: "reference-esm-suffix-decoy-test",
      policy: { secretPatterns: [] },
    });
    if (!result.ok) throw result.error;
    expect(result.value.parse_failures).toEqual([]);
    expect(result.value.relationships).toHaveLength(2);
    for (const to of ["dep.mjs", "fragment.mjs"])
      expect(result.value.relationships).toContainEqual({
        from_path: "main.mjs",
        to,
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      });
  },
);

it.skipIf(process.platform === "win32").each([
  ["URL whitespace", "./de\tp.mjs ", "dep.mjs", ["de\tp.mjs "]],
  ["discarded encoded separators", "./discard%2f/../dep.mjs", "dep.mjs", []],
  ["URL scalar values", "./dep\ud800.mjs", "dep\ufffd.mjs", []],
  ["leading empty segments", ".//dep.mjs", "dep.mjs", []],
  ["retained leading empty segments", "./a/..//dep.mjs", "dep.mjs", []],
] as const)(
  "normalizes ESM %s before filesystem lookup",
  async (_label, specifier, target, decoys) => {
    const root = await createTestTempDirectory(
      "rea-reference-esm-normalization-",
    );
    await Promise.all([
      writeFile(
        join(root, "main.mjs"),
        `import ${JSON.stringify(specifier)};\n`,
      ),
      ...[target, ...decoys].map((path) =>
        writeFile(join(root, path), "export {};\n"),
      ),
    ]);
    expect(
      normalize(
        fileURLToPath(
          new URL(specifier, pathToFileURL(join(root, "main.mjs"))),
        ),
      ),
    ).toBe(join(root, target));
    const result = await importReferenceSource({
      root,
      caller: "reference-esm-normalization-test",
      policy: { secretPatterns: [] },
    });
    if (!result.ok) throw result.error;
    expect(result.value.parse_failures).toEqual([]);
    expect(result.value.relationships).toEqual([
      {
        from_path: "main.mjs",
        to: target,
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
    ]);
  },
);

it("resolves ESM dot segments before collapsing repeated URL separators", async () => {
  const root = await createTestTempDirectory("rea-reference-esm-segments-");
  await Promise.all(
    ["assets", "double"].map((path) => mkdir(join(root, path))),
  );
  await Promise.all([
    writeFile(
      join(root, "main.mjs"),
      [
        'import "./assets//%2e%2e/app.mjs";',
        'import "./missing//%2e%2e/ghost.mjs";',
        'import "./double//direct.mjs";',
      ].join("\n"),
    ),
    writeFile(join(root, "main.cjs"), 'require("./assets//../app.mjs");\n'),
    ...["app.mjs", "assets/app.mjs", "ghost.mjs", "double/direct.mjs"].map(
      (path) => writeFile(join(root, path), "export {};\n"),
    ),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-segments-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toHaveLength(4);
  for (const relationship of [
    {
      from_path: "main.cjs",
      to: "app.mjs",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "main.mjs",
      to: "assets/app.mjs",
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "main.mjs",
      to: "missing/ghost.mjs",
      kind: "imports",
      resolution: "unresolved",
      parse_state: "parsed",
    },
    {
      from_path: "main.mjs",
      to: "double/direct.mjs",
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    },
  ])
    expect(result.value.relationships).toContainEqual(relationship);
});

it("selects the package main for a JavaScript source directory import", async () => {
  const root = await createTestTempDirectory(
    "rea-reference-esm-directory-main-",
  );
  await mkdir(join(root, "pkg"));
  await Promise.all([
    writeFile(join(root, "main.mjs"), 'import "./pkg/";\nimport "./pkg//";\n'),
    writeFile(join(root, "pkg/package.json"), '{"main":"actual.js"}\n'),
    writeFile(join(root, "pkg/index.js"), "export const decoy = true;\n"),
    writeFile(join(root, "pkg/actual.js"), "export const selected = true;\n"),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-esm-directory-main-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toEqual([
    {
      from_path: "main.mjs",
      to: "pkg/actual.js",
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    },
  ]);
});
