import { createServer } from "node:http";

export function createRunnerServer() {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ status: "ok", service: "runner" }));
  });
}
