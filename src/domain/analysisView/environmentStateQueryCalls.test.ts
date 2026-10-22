import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { readOnlyTools } from "./environmentStateQueryCalls.js";
import type {
  StateRecordFacts,
  StateToolFacts,
} from "./environmentStateRules.js";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly status?: number | null;
  readonly response?: JsonValue;
  readonly request?: JsonValue;
  readonly tool: string;
  readonly template?: string;
}

/** The read-only tools of a timeline of calls, ordinals in order. */
const readOnlyOf = (calls: readonly Call[]): string[] => {
  const records: StateRecordFacts[] = calls.map((call, index) => ({
    ordinal: index,
    method: call.method,
    path: call.path,
    query: call.query,
    status: call.status === undefined ? 200 : call.status,
    start: index,
    end: index,
  }));
  const tools = new Map<string, StateToolFacts>();
  calls.forEach((call, index) => {
    const known = tools.get(call.tool);
    tools.set(call.tool, {
      name: call.tool,
      method: call.method,
      path_template: call.template ?? call.path,
      record_ordinals: [...(known?.record_ordinals ?? []), index],
    });
  });
  return [
    ...readOnlyTools([...tools.values()], records, {
      response: (ordinal) => calls[ordinal]?.response,
      request: (ordinal) => calls[ordinal]?.request,
    }),
  ].sort();
};

const JOBS = [{ id: "night-watch", status: "running" }];

describe("POSTs that read state", () => {
  it("reads a POST answering as the latest GET of its path did, with no write between", () => {
    const get = {
      method: "GET",
      path: "/v1/jobs/statuses",
      tool: "get_statuses",
      response: JOBS,
    };
    const post = {
      method: "POST",
      path: "/v1/jobs/statuses",
      tool: "post_statuses",
      request: { jobs: ["night-watch"] },
    };
    expect(readOnlyOf([get, { ...post, response: JOBS }])).toEqual([
      "post_statuses",
    ]);
    expect(readOnlyOf([get, { ...post, response: [] }])).toEqual([]);
    const write = {
      method: "PUT",
      path: "/v1/job/night-watch",
      tool: "put_job",
      response: {},
    };
    expect(readOnlyOf([get, write, { ...post, response: JOBS }])).toEqual([]);
  });

  it("reads an RPC tunnel whose calls name only read operations, in the body or the query", () => {
    const tunnel = (operations: string[]): Call => ({
      method: "POST",
      path: "/api/v2/internal/nc/base1",
      query: "?operation=batch",
      template: "/api/v2/internal/nc/{uid}",
      tool: "post_internal",
      request: {
        operations: operations.map((operation) => ({ operation, query: {} })),
      },
      response: { results: [] },
    });
    expect(readOnlyOf([tunnel(["tableSyncList", "listScripts"])])).toEqual([
      "post_internal",
    ]);
    expect(
      readOnlyOf([tunnel(["tableList"]), tunnel(["tableCreate"])]),
    ).toEqual([]);
    // A container operation names no operation of its own.
    expect(readOnlyOf([{ ...tunnel([]), request: {} }])).toEqual([]);
    const queried = {
      method: "POST",
      path: "/rpc",
      query: "?op=getUser",
      tool: "post_rpc",
      response: {},
    };
    expect(readOnlyOf([queried])).toEqual(["post_rpc"]);
  });

  it("skips a container operation in the body as in the query, still needing a real read", () => {
    const rpc = (request: JsonValue): Call => ({
      method: "POST",
      path: "/rpc",
      tool: "post_rpc",
      request,
      response: {},
    });
    const batch = (operation: string): JsonValue => ({
      operation: "batch",
      operations: [{ operation }],
    });
    expect(readOnlyOf([rpc(batch("getUser"))])).toEqual(["post_rpc"]);
    expect(readOnlyOf([rpc(batch("createUser"))])).toEqual([]);
    expect(readOnlyOf([rpc({ operation: "batch" })])).toEqual([]);
  });

  it("reads a POST whose path names a lookup word, split on underscores, hyphens and case", () => {
    const post = (path: string, tool: string, template = path): Call => ({
      method: "POST",
      path,
      template,
      tool,
      response: [],
    });
    expect(
      readOnlyOf([
        post("/api/documents/selection_data/", "post_selection"),
        post(
          "/api/v4/channels/c1/members/ids",
          "post_member_ids",
          "/api/v4/channels/{uid}/members/ids",
        ),
        post("/v1/discover", "post_discover"),
        post("/api/members", "post_members"),
      ]),
    ).toEqual(["post_discover", "post_member_ids", "post_selection"]);
  });

  it("reads a lookup by a segment's last meaningful word, so a query history stays a write", () => {
    const post = (path: string, tool: string): Call => ({
      method: "POST",
      path,
      tool,
      response: {},
    });
    expect(
      readOnlyOf([
        post("/api/query-history", "post_query_history"),
        post("/api/documents/selection_data/", "post_selection"),
        post("/api/search-results", "post_search_results"),
      ]),
    ).toEqual(["post_search_results", "post_selection"]);
  });

  it("reads a lookup only by the last literal segment, so a trailing write action stays a write", () => {
    const post = (path: string, tool: string, template = path): Call => ({
      method: "POST",
      path,
      template,
      tool,
      response: {},
    });
    expect(
      readOnlyOf([
        post("/api/documents/selection_data/import", "post_import"),
        post("/api/saved-query/create", "post_saved_query"),
        post("/api/views/create_lookup", "post_create_lookup"),
        post(
          "/api/lookup_data/users",
          "post_lookup",
          "/api/lookup_data/{kind}",
        ),
      ]),
    ).toEqual(["post_lookup"]);
  });

  it("reads a session renewal, not a create in the same collection tree", () => {
    const post = (path: string, tool: string): Call => ({
      method: "POST",
      path,
      tool,
      response: { token: "x" },
    });
    expect(
      readOnlyOf([
        post("/api/collections/_superusers/auth-refresh", "post_auth_refresh"),
        post("/api/collections/notes/records", "post_records"),
      ]),
    ).toEqual(["post_auth_refresh"]);
  });
});

describe("POSTs that read state but stay writes", () => {
  it("keeps a lookup-named POST a write when a read its path relates to changes across it alone", () => {
    const read = (members: string[]): Call => ({
      method: "GET",
      path: "/api/members",
      tool: "get_members",
      response: members,
    });
    const post: Call = {
      method: "POST",
      path: "/api/members/ids",
      tool: "post_ids",
      response: ["a"],
    };
    expect(readOnlyOf([read(["a"]), post, read(["a", "b"])])).toEqual([]);
    expect(readOnlyOf([read(["a"]), post, read(["a"])])).toEqual(["post_ids"]);
    // Another write between explains the change, so the POST stays read-only.
    const other: Call = {
      method: "PUT",
      path: "/api/members/b",
      tool: "put_member",
      response: {},
    };
    expect(readOnlyOf([read(["a"]), post, other, read(["a", "b"])])).toEqual([
      "post_ids",
    ]);
  });

  it("keeps a lookup-named POST a write when only another read-only POST sits between it and a changed read", () => {
    const read = (members: string[]): Call => ({
      method: "GET",
      path: "/api/members",
      tool: "get_members",
      response: members,
    });
    const post: Call = {
      method: "POST",
      path: "/api/members/ids",
      tool: "post_ids",
      response: ["a"],
    };
    const refresh: Call = {
      method: "POST",
      path: "/api/collections/_superusers/auth-refresh",
      tool: "post_auth_refresh",
      response: { token: "x" },
    };
    expect(readOnlyOf([read(["a"]), post, refresh, read(["a", "b"])])).toEqual([
      "post_auth_refresh",
    ]);
    expect(readOnlyOf([read(["a"]), refresh, post, read(["a", "b"])])).toEqual([
      "post_auth_refresh",
    ]);
  });

  it("keeps a POST a write when one of its calls was redirected or went unanswered", () => {
    const post = (status: number | null): Call => ({
      method: "POST",
      path: "/api/members/ids",
      tool: "post_ids",
      status,
      response: ["a"],
    });
    expect(readOnlyOf([post(200), post(302)])).toEqual([]);
    expect(readOnlyOf([post(200), post(null)])).toEqual([]);
    // A refused call changed nothing, so it does not hold the tool.
    expect(readOnlyOf([post(200), post(400)])).toEqual(["post_ids"]);
  });
});
