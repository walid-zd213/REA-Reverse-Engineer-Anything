import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated, trackBrowser } from "./cdpBrowserProvider.support.js";

const observeDuringClockSampling = async (
  commandEvents: NonNullable<FakeOptions["commandEvents"]>,
) => {
  return observeWithFake({
    eventsBeforeReply: ["Performance.getMetrics"],
    commandResult: (command) =>
      command.method === "Performance.getMetrics"
        ? { metrics: [{ name: "Timestamp", value: 20 }] }
        : undefined,
    commandEvents,
  });
};

const observeWithFake = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );
  if (!result.ok) throw result.error;
  return { browser, observation: result.value };
};

const laterInWindowRequest = (
  command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
  origin: string,
) => ({
  method: "Network.requestWillBeSent",
  sessionId: command.sessionId,
  params: {
    requestId: "later-in-window-request",
    timestamp: 21,
    type: "Document",
    frameId: "frame-main",
    redirectResponse: { url: `${origin}/prior` },
    request: { url: `${origin}/later` },
  },
});

const expectNoCommittedFrameWithInvalidTimeline = (
  observation: Awaited<ReturnType<typeof observeWithFake>>["observation"],
) => {
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ type: "navigation_committed" }),
  );
  expect(observation.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
};

it("fails closed on an untimestamped cross-origin main-frame commit during clock sampling", async () => {
  const { observation } = await observeDuringClockSampling(
    (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        frameNavigated(command, {
          id: "frame-main",
          loaderId: "outside-loader",
          url: "https://outside.invalid/path",
        }),
        laterInWindowRequest(command, origin),
      ];
    },
  );

  expect(observation.window.end_reason).toBe("target_left_scope");
  expect(observation.target.final_url).toBeNull();
  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "navigation_committed",
      loader_id: "outside-loader",
      timestamp: null,
      destination_scope: "outside_policy",
      url: null,
    }),
  );
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "later-in-window-request" }),
  );
});

it("keeps an unidentifiable frame commit unknown without inventing a main-frame event", async () => {
  const { observation } = await observeDuringClockSampling((command) =>
    command.method === "Performance.getMetrics"
      ? [frameNavigated(command, { url: "https://outside.invalid/unknown" })]
      : undefined,
  );

  expect(observation.window.end_reason).toBe("window_elapsed");
  expectNoCommittedFrameWithInvalidTimeline(observation);
});

it("marks a frame event with absent parameters as unknown timeline evidence", async () => {
  const { observation } = await observeDuringClockSampling((command) =>
    command.method === "Performance.getMetrics"
      ? [
          {
            method: "Page.frameNavigated",
            sessionId: command.sessionId,
            params: undefined,
          },
        ]
      : undefined,
  );

  expectNoCommittedFrameWithInvalidTimeline(observation);
  expect(observation.completeness.unavailable_sections).toContain("timeline");
});

it("records a malformed child identity without treating it as the main frame", async () => {
  const { observation } = await observeDuringClockSampling((command) =>
    command.method === "Performance.getMetrics"
      ? [
          frameNavigated(command, {
            id: 3,
            parentId: "frame-main",
            url: "https://outside.invalid/child",
          }),
        ]
      : undefined,
  );

  expect(observation.window.end_reason).toBe("window_elapsed");
  expectNoCommittedFrameWithInvalidTimeline(observation);
});

it("updates the main frame from a pre-arm root replacement without inventing a navigation row", async () => {
  const { observation } = await observeDuringClockSampling((command, origin) =>
    command.method === "Performance.getMetrics"
      ? [
          frameNavigated(command, {
            id: "replacement-main",
            loaderId: "replacement-loader",
            url: `${origin}/app?token=frame-secret`,
          }),
          {
            method: "Page.lifecycleEvent",
            sessionId: command.sessionId,
            params: {
              frameId: "replacement-main",
              loaderId: "replacement-loader",
              name: "DOMContentLoaded",
              timestamp: 21,
            },
          },
        ]
      : undefined,
  );

  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ type: "navigation_committed" }),
  );
  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "lifecycle",
      frame_id: "replacement-main",
      loader_id: "replacement-loader",
      timestamp: 21,
      detail: "domcontentloaded",
    }),
  );
  expect(observation.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Buffered events with unknown timing"),
    ]),
  );
});

it("fails closed on an untimestamped out-of-scope main-frame request during clock sampling", async () => {
  const { observation } = await observeDuringClockSampling(
    (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        {
          method: "Page.frameRequestedNavigation",
          sessionId: command.sessionId,
          params: {
            frameId: "frame-main",
            url: "https://outside.invalid/path",
            reason: "scriptInitiated",
          },
        },
        laterInWindowRequest(command, origin),
      ];
    },
  );

  expect(observation.window.end_reason).toBe("target_left_scope");
  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "navigation_requested",
      timestamp: null,
      destination_scope: "outside_policy",
      url: null,
    }),
  );
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "later-in-window-request" }),
  );
});

it("fails closed on an untimestamped out-of-scope redirect during clock sampling", async () => {
  const { observation } = await observeDuringClockSampling(
    (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "unknown-time-outside-redirect",
            type: "Document",
            frameId: "frame-main",
            redirectResponse: { url: `${origin}/prior` },
            request: { url: "https://outside.invalid/redirected" },
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "later-in-window-request",
            timestamp: 21,
            type: "Document",
            frameId: "frame-main",
            redirectResponse: { url: `${origin}/prior` },
            request: { url: `${origin}/later` },
          },
        },
      ];
    },
  );

  expect(observation.window.end_reason).toBe("target_left_scope");
  expect(observation.target.final_url).toBeNull();
  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "redirect",
      request_id: "unknown-time-outside-redirect",
      timestamp: null,
      destination_scope: "outside_policy",
      url: null,
    }),
  );
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "later-in-window-request" }),
  );
});

it.each([
  [
    "Inspector.targetCrashed",
    "target_terminated",
    "target_terminated",
    {
      method: "Inspector.targetCrashed",
      sessionId: "session-1",
      params: {},
    },
  ],
  [
    "Target.detachedFromTarget",
    "session_detached",
    "session_detached",
    {
      method: "Target.detachedFromTarget",
      params: { sessionId: "session-1", targetId: "allowed-page" },
    },
  ],
] as const)(
  "ends on buffered untimestamped %s before collecting later events",
  async (_method, endReason, eventType, terminalEvent) => {
    const { observation } = await observeWithFake({
      eventsBeforeReply: ["Performance.getMetrics"],
      commandResult: (command) =>
        command.method === "Performance.getMetrics"
          ? { metrics: [{ name: "Timestamp", value: 20 }] }
          : undefined,
      commandEvents: (command, origin) => {
        if (command.method !== "Performance.getMetrics") return undefined;
        return [
          terminalEvent,
          {
            method: "Network.requestWillBeSent",
            sessionId: command.sessionId,
            params: {
              requestId: "after-terminal-event",
              timestamp: 21,
              type: "Document",
              frameId: "frame-main",
              redirectResponse: { url: `${origin}/prior` },
              request: { url: `${origin}/later` },
            },
          },
        ];
      },
    });

    expect(observation.window.end_reason).toBe(endReason);
    expect(observation.timeline).toContainEqual(
      expect.objectContaining({
        type: eventType,
        timestamp: null,
      }),
    );
    expect(observation.timeline).not.toContainEqual(
      expect.objectContaining({ request_id: "after-terminal-event" }),
    );
    expect(observation.limitations).toContain(
      "Timeline rows without a comparable producer timestamp have a null timestamp. Buffered events with unknown timing are retained as context only; they do not establish activity inside the selected observation window.",
    );
  },
);

it("records a load failure only for a main-frame document that has not finished", async () => {
  const documentRequest = (
    command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
    origin: string,
    requestId: string,
  ) => ({
    method: "Network.requestWillBeSent",
    sessionId: command.sessionId,
    params: {
      requestId,
      timestamp: 21,
      type: "Document",
      frameId: "frame-main",
      request: { url: `${origin}/${requestId}` },
    },
  });
  const loadingFailed = (
    command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
    requestId: string,
  ) => ({
    method: "Network.loadingFailed",
    sessionId: command.sessionId,
    params: {
      requestId,
      timestamp: 22,
      type: "Document",
      errorText: "net::ERR_CONNECTION_REFUSED",
    },
  });
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        documentRequest(command, origin, "finished-document"),
        {
          method: "Network.loadingFinished",
          sessionId: command.sessionId,
          params: { requestId: "finished-document", timestamp: 22 },
        },
        // A finished request is no longer tracked, so a stray failure for it
        // is not attributed to the main frame.
        loadingFailed(command, "finished-document"),
        documentRequest(command, origin, "failed-document"),
        loadingFailed(command, "failed-document"),
      ];
    },
  });

  expect(
    observation.timeline
      .filter((event) => event.type === "load_failed")
      .map((event) => event.request_id),
  ).toEqual(["failed-document"]);
});

it("uses the failure's resource type when a main-frame request omits its type", async () => {
  const untypedRequest = (
    command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
    origin: string,
    requestId: string,
  ) => ({
    method: "Network.requestWillBeSent",
    sessionId: command.sessionId,
    params: {
      requestId,
      timestamp: 21,
      frameId: "frame-main",
      request: { url: `${origin}/${requestId}` },
    },
  });
  const loadingFailed = (
    command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
    requestId: string,
    type?: string,
  ) => ({
    method: "Network.loadingFailed",
    sessionId: command.sessionId,
    params: {
      requestId,
      timestamp: 22,
      ...(type === undefined ? {} : { type }),
      errorText: "net::ERR_CONNECTION_REFUSED",
    },
  });
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        untypedRequest(command, origin, "untyped-image"),
        loadingFailed(command, "untyped-image", "Image"),
        untypedRequest(command, origin, "untyped-document"),
        loadingFailed(command, "untyped-document", "Document"),
        untypedRequest(command, origin, "untyped-unknown"),
        loadingFailed(command, "untyped-unknown"),
      ];
    },
  });

  expect(
    observation.timeline
      .filter((event) => event.type === "load_failed")
      .map((event) => event.request_id),
  ).toEqual(["untyped-document"]);
  // Neither event declared a type, so the failure stays unknown.
  expect(observation.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
});

it("does not report an untyped failure before the window as incomplete coverage", async () => {
  const { observation } = await observeDuringClockSampling(
    (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "untyped-before-window",
            timestamp: 18,
            frameId: "frame-main",
            request: { url: `${origin}/untyped-before-window` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "untyped-before-window",
            timestamp: 19,
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  );

  expect(
    observation.timeline.filter((event) => event.type === "load_failed"),
  ).toEqual([]);
  expect(observation.completeness.excluded).not.toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
});

it("reports a document failure whose request omitted its frame as unknown coverage", async () => {
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "frameless-document",
            timestamp: 21,
            type: "Document",
            request: { url: `${origin}/frameless-document` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "frameless-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "child-frame-document",
            timestamp: 21,
            type: "Document",
            frameId: "frame-child",
            request: { url: `${origin}/child-frame-document` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "child-frame-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  });

  // Neither failure is attributed to the main frame. Only the frameless one
  // leaves ownership unknown; the child frame's failure is out of scope.
  expect(
    observation.timeline.filter((event) => event.type === "load_failed"),
  ).toEqual([]);
  expect(
    observation.completeness.excluded.filter(
      (exclusion) =>
        exclusion.section === "timeline" &&
        exclusion.reason === "invalid_protocol_value",
    ),
  ).toEqual([expect.objectContaining({ count: 1 })]);
});

it("reports a possible document failure without a request ID as unknown coverage", async () => {
  const failureWithoutRequestId = (
    command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
    type: string,
  ) => ({
    method: "Network.loadingFailed",
    sessionId: command.sessionId,
    params: {
      timestamp: 22,
      type,
      errorText: "net::ERR_CONNECTION_REFUSED",
    },
  });
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        failureWithoutRequestId(command, "Image"),
        failureWithoutRequestId(command, "Document"),
      ];
    },
  });

  // The image is filtered by its own type; the document cannot be joined to a
  // frame, so its coverage is reported as unknown.
  expect(
    observation.timeline.filter((event) => event.type === "load_failed"),
  ).toEqual([]);
  expect(
    observation.completeness.excluded.filter(
      (exclusion) =>
        exclusion.section === "timeline" &&
        exclusion.reason === "invalid_protocol_value",
    ),
  ).toEqual([expect.objectContaining({ count: 1 })]);
});

it("keeps main-frame ownership across a redirect hop that omits its frame", async () => {
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "redirected-document",
            timestamp: 21,
            type: "Document",
            frameId: "frame-main",
            request: { url: `${origin}/first-hop` },
          },
        },
        {
          // The continuation reuses the request ID and omits its frame.
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "redirected-document",
            timestamp: 21.5,
            type: "Document",
            redirectResponse: { url: `${origin}/first-hop`, status: 302 },
            request: { url: `${origin}/second-hop` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "redirected-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  });

  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "load_failed",
      request_id: "redirected-document",
    }),
  );
});

it("keeps child-frame ownership across a redirect hop that omits its frame", async () => {
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "redirected-child-document",
            timestamp: 21,
            type: "Document",
            frameId: "frame-child",
            request: { url: `${origin}/child-first-hop` },
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "redirected-child-document",
            timestamp: 21.5,
            type: "Document",
            redirectResponse: { url: `${origin}/child-first-hop`, status: 302 },
            request: { url: `${origin}/child-second-hop` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "redirected-child-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  });

  // The first hop proved another frame, so the failure is out of scope.
  expect(
    observation.timeline.filter((event) => event.type === "load_failed"),
  ).toEqual([]);
  expect(observation.completeness.excluded).not.toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
});

it("attributes a failure to a root replacement that commits after its request", async () => {
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "replacement-document",
            timestamp: 21,
            type: "Document",
            frameId: "replacement-main",
            request: { url: `${origin}/replacement` },
          },
        },
        frameNavigated(command, {
          id: "replacement-main",
          loaderId: "replacement-loader",
          url: `${origin}/replacement`,
        }),
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "replacement-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  });

  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "load_failed",
      request_id: "replacement-document",
    }),
  );
});

it("keeps contradictory redirect ownership unknown after a later hop agrees again", async () => {
  const hop = (
    command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
    origin: string,
    frameId: string,
    hopIndex: number,
  ) => ({
    method: "Network.requestWillBeSent",
    sessionId: command.sessionId,
    params: {
      requestId: "contradictory-document",
      timestamp: 21 + hopIndex / 10,
      type: "Document",
      frameId,
      ...(hopIndex === 0
        ? {}
        : { redirectResponse: { url: `${origin}/hop-${String(hopIndex)}` } }),
      request: { url: `${origin}/hop-${String(hopIndex + 1)}` },
    },
  });
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        hop(command, origin, "frame-main", 0),
        hop(command, origin, "frame-child", 1),
        hop(command, origin, "frame-main", 2),
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "contradictory-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  });

  expect(
    observation.timeline.filter((event) => event.type === "load_failed"),
  ).toEqual([]);
  expect(observation.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
});

it("treats an empty request frame ID as unknown ownership", async () => {
  const { observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "empty-frame-document",
            timestamp: 21,
            type: "Document",
            frameId: "",
            request: { url: `${origin}/empty-frame-document` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "empty-frame-document",
            timestamp: 22,
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
          },
        },
      ];
    },
  });

  expect(
    observation.timeline.filter((event) => event.type === "load_failed"),
  ).toEqual([]);
  expect(observation.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
});

it("represents absent timeline timestamps as unknown and preserves an observed zero", async () => {
  const { browser, observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Page.navigatedWithinDocument",
          sessionId: command.sessionId,
          params: {
            frameId: "frame-main",
            url: `${origin}/without-clock-value`,
            navigationType: "historyApi",
          },
        },
        // Network.loadingFailed has no frame; its Document request ties it
        // to the main frame.
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "actual-zero-clock-value",
            timestamp: 0,
            type: "Document",
            frameId: "frame-main",
            request: { url: `${origin}/actual-zero-clock-value` },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "actual-zero-clock-value",
            errorText: "net::ERR_CONNECTION_REFUSED",
            timestamp: 0,
          },
        },
      ];
    },
  });

  expect(observation.timeline).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "same_document_navigation",
        url: `${browser.allowedOrigin}/without-clock-value`,
        timestamp: null,
      }),
      expect.objectContaining({
        type: "load_failed",
        request_id: "actual-zero-clock-value",
        timestamp: 0,
      }),
    ]),
  );
});

it("ends an armed observation at a fatal protocol failure without waiting out its window", async () => {
  const browser = await startFakeCdpBrowser({
    malformedEventOnMethod: "Page.setLifecycleEventsEnabled",
  });
  trackBrowser(browser);
  const started = performance.now();
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 10_000,
    }),
  );
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "BrowserObservationError", reason: "protocol_error" },
  });
}, 15_000);
