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

  it("rejects an unload payload above the keepalive body budget", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
    });

    await expect(
      sender.send({
        body: new Uint8Array(60 * 1024 + 1),
        contentType: "application/json",
        unloading: true,
      }),
    ).rejects.toThrow("cannot fit within the 61440 byte and 9 request keepalive budget");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies the keepalive body budget across pending requests", async () => {
    let completeFirstRequest: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeFirstRequest = resolve;
        }),
    );
    const sender = new Sender({
      endpoint: "https://example.test/v2.1/track",
      fetch,
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
    ).rejects.toThrow("cannot fit within the 61440 byte and 9 request keepalive budget");
    expect(fetch).toHaveBeenCalledOnce();

    completeFirstRequest?.(new Response(null, { status: 200 }));
    await firstSend;
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
    await expect(sender.send(request)).resolves.toEqual({ statusCode: 200, result: "" });
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
    ).resolves.toEqual({ statusCode: 200, result: "" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
