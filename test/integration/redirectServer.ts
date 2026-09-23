// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    redirectEndpoint: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let redirectRequests = 0;
  let finalRequests = 0;

  const finalServer = createServer((request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v2.1/track") {
      finalRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ itemsAccepted: 1, itemsReceived: 1, errors: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  const finalOrigin = await listen(finalServer);

  const redirectServer = createServer((request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v2.1/track") {
      redirectRequests++;
      response.writeHead(307, { location: `${finalOrigin}/v2.1/track` }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/counts") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ redirectRequests, finalRequests }));
      return;
    }
    response.writeHead(404).end();
  });
  const redirectOrigin = await listen(redirectServer);
  project.provide("redirectEndpoint", `${redirectOrigin}/v2.1/track`);

  return async () => {
    await Promise.all([close(redirectServer), close(finalServer)]);
  };
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, content-encoding");
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Redirect test server did not bind to a TCP port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
