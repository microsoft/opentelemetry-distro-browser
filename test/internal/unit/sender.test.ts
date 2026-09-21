// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { Sender } from "../../../src/exporter/sender.js";

describe("Sender", () => {
  it("posts a payload and returns the Breeze response", async () => {
    const response = new Response('{"itemsAccepted":1,"itemsReceived":1,"errors":[]}', {
      status: 200,
      headers: { "retry-after": "120" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
    });
    const body = new TextEncoder().encode("telemetry");

    await expect(sender.send({ body, contentType: "application/json" })).resolves.toEqual({
      transport: "fetch",
      statusCode: 200,
      result: '{"itemsAccepted":1,"itemsReceived":1,"errors":[]}',
      retryAfterMs: 120_000,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://example.test/v2.1/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: false,
    });
  });

  it("uses keepalive for an unload send", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
    });
    const body = new Uint8Array(60 * 1024);

    await sender.send({ body, contentType: "application/json", unloading: true });

    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/v2.1/track",
      expect.objectContaining({ body, keepalive: true }),
    );
  });

  it("uses sendBeacon when an unload payload exceeds the keepalive body budget", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });

    await expect(
      sender.send({
        body: new Uint8Array(60 * 1024 + 1),
        contentType: "application/json",
        unloading: true,
      }),
    ).resolves.toEqual({ transport: "beacon" });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledOnce();
    const [endpoint, body] = sendBeacon.mock.calls[0];
    expect(endpoint).toBe("https://example.test/v2.1/track");
    expect(body).toBeInstanceOf(Blob);
    expect(body).toMatchObject({ size: 60 * 1024 + 1, type: "application/json" });
  });

  it("applies the keepalive body budget across pending requests", async () => {
    let completeFirstRequest: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeFirstRequest = resolve;
        }),
    );
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });
    const firstSend = sender.send({
      body: new Uint8Array(40 * 1024),
      contentType: "application/json",
      unloading: true,
    });

    await expect(
      sender.send({
        body: new Uint8Array(21 * 1024),
        contentType: "application/json",
        unloading: true,
      }),
    ).resolves.toEqual({ transport: "beacon" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sendBeacon).toHaveBeenCalledOnce();

    completeFirstRequest?.(new Response(null, { status: 200 }));
    await firstSend;
  });

  it("shares the keepalive body budget across sender instances", async () => {
    let completeFirstRequest: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeFirstRequest = resolve;
        }),
    );
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const firstSender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });
    const secondSender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });
    const firstSend = firstSender.send({
      body: new Uint8Array(40 * 1024),
      contentType: "application/json",
      unloading: true,
    });

    await expect(
      secondSender.send({
        body: new Uint8Array(21 * 1024),
        contentType: "application/json",
        unloading: true,
      }),
    ).resolves.toEqual({ transport: "beacon" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sendBeacon).toHaveBeenCalledOnce();

    completeFirstRequest?.(new Response(null, { status: 200 }));
    await firstSend;
  });

  it("uses sendBeacon when the keepalive request budget is exhausted", async () => {
    const completeRequests: Array<(response: Response) => void> = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          completeRequests.push(resolve);
        }),
    );
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });
    const pendingSends = Array.from({ length: 9 }, () =>
      sender.send({
        body: new Uint8Array(1),
        contentType: "application/json",
        unloading: true,
      }),
    );

    await expect(
      sender.send({
        body: new Uint8Array(1),
        contentType: "application/json",
        unloading: true,
      }),
    ).resolves.toEqual({ transport: "beacon" });
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(sendBeacon).toHaveBeenCalledOnce();

    for (const completeRequest of completeRequests) {
      completeRequest(new Response(null, { status: 200 }));
    }
    await Promise.all(pendingSends);
  });

  it("releases the keepalive budget after a request completes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
    });
    const request = {
      body: new Uint8Array(60 * 1024),
      contentType: "application/json",
      unloading: true,
    } as const;

    await sender.send(request);
    await expect(sender.send(request)).resolves.toEqual({
      transport: "fetch",
      statusCode: 200,
      result: "",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized payload before calling fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      maxPayloadSize: 4,
    });

    await expect(
      sender.send({ body: new Uint8Array(5), contentType: "application/json" }),
    ).rejects.toThrow("exceeds the 4 byte limit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a positive payload limit", () => {
    expect(
      () =>
        new Sender({
          endpoint: "https://example.test/v2.1/track",
          fetch: vi.fn<typeof globalThis.fetch>(),
          maxPayloadSize: 0,
        }),
    ).toThrow("maxPayloadSize must be greater than zero");
  });

  it("does not impose a payload limit when none has been established", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
    });

    await expect(
      sender.send({ body: new Uint8Array(65_001), contentType: "application/json" }),
    ).resolves.toEqual({ transport: "fetch", statusCode: 200, result: "" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses sendBeacon when an unload fetch fails", async () => {
    const fetchError = new TypeError("fetch failed");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(fetchError);
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });

    await expect(
      sender.send({
        body: new TextEncoder().encode("telemetry"),
        contentType: "application/json",
        unloading: true,
      }),
    ).resolves.toEqual({ transport: "beacon" });
    expect(sendBeacon).toHaveBeenCalledOnce();
  });

  it("fails when sendBeacon cannot queue the unload request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(false);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });

    await expect(
      sender.send({
        body: new Uint8Array(60 * 1024 + 1),
        contentType: "application/json",
        unloading: true,
      }),
    ).rejects.toThrow("sendBeacon could not queue the unload request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unload payload above the beacon body limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
    });

    await expect(
      sender.send({
        body: new Uint8Array(65_001),
        contentType: "application/json",
        unloading: true,
      }),
    ).rejects.toThrow("exceeds the 65000 byte beacon limit");
    expect(fetch).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("does not use sendBeacon when the fallback is disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sendBeacon = vi.fn<typeof globalThis.navigator.sendBeacon>().mockReturnValue(true);
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
      sendBeacon,
      disableBeacon: true,
    });

    await expect(
      sender.send({
        body: new Uint8Array(60 * 1024 + 1),
        contentType: "application/json",
        unloading: true,
      }),
    ).rejects.toThrow("sendBeacon fallback is unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
