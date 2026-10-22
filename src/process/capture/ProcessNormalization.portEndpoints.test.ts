import { expect, it } from "vitest";

import { createBoundedProcessTextNormalizer } from "./ProcessNormalization.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";

const scenario = parseProcessScenario({
  executable: "/usr/bin/node",
  working_directory: "/workspace",
  normalization: {
    paths: false,
    pids: false,
    ports: true,
    patterns: [],
  },
});

const normalize = createBoundedProcessTextNormalizer(
  scenario,
  "/temporary",
  41_010,
);

it("preserves endpoint-only port normalization when the field pass is unchanged", () => {
  const input = "localhost:8080";
  const value = "localhost:<port>";

  expect(normalize(input, Buffer.byteLength(value))).toEqual({
    state: "normalized",
    value,
    utf8Bytes: Buffer.byteLength(value),
  });
});

it("keeps endpoint and explicit-field normalization together", () => {
  const input = "localhost:8080 port:8080";
  const value = "localhost:<port> port:<port>";

  expect(normalize(input, Buffer.byteLength(value))).toEqual({
    state: "normalized",
    value,
    utf8Bytes: Buffer.byteLength(value),
  });
});
