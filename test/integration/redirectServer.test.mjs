// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { test } from "node:test";
import setup from "./redirectServer.ts";

for (const server of ["ingestion", "redirect", "destination"]) {
  for (const pendingRequest of [false, true]) {
    test(
      `${server} teardown closes ${pendingRequest ? "incomplete HTTP requests" : "unused browser connections"}`,
      { timeout: 5_000 },
      async (t) => {
        const endpoints = new Map();
        const teardown = await setup({ provide: (key, value) => endpoints.set(key, value) });
        let socket;
        let closing;
        t.after(async () => {
          socket?.destroy();
          await (closing ?? teardown());
        });

        let endpoint = endpoints.get(`${server}Endpoint`);
        if (server === "destination") {
          const response = await fetch(endpoints.get("redirectEndpoint"), {
            method: "POST",
            redirect: "manual",
          });
          assert.equal(response.status, 307);
          endpoint = response.headers.get("location");
          await response.arrayBuffer();
        }
        assert.ok(endpoint);
        const { hostname, port } = new URL(endpoint);
        socket = createConnection({ host: hostname, port: Number(port) });
        await once(socket, "connect", { signal: t.signal });
        if (pendingRequest) {
          socket.write("POST /v2.1/track HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n");
        }

        const signal = AbortSignal.timeout(1_000);
        const closed = once(socket, "close", { signal }).catch((error) => {
          // Closing an incomplete request may reset the client socket before it closes.
          assert.equal(error.code, "ECONNRESET");
          return once(socket, "close", { signal });
        });
        closing = teardown();
        await Promise.all([closing, closed]);
        assert.equal(socket.destroyed, true);
      },
    );
  }
}
