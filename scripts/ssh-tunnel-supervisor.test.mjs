import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { monitorTunnel, probeEnvironment } from "./ssh-tunnel-supervisor.mjs";

NodeTest.test("restarts a live tunnel only after consecutive application failures", async () => {
  const results = [false, false, true, false, false, false];
  let checks = 0;
  const reason = await monitorTunnel({
    signal: new AbortController().signal,
    lanAddress: "192.0.2.1",
    pause: async () => {},
    health: async () => results[checks++],
    findLan: async () => {
      throw new Error("A working LAN route should not be replaced");
    },
  });
  NodeAssert.equal(reason, "application failed three health checks");
  NodeAssert.equal(checks, 6);
});

NodeTest.test("leaves a healthy fallback only after the same LAN route is stable", async () => {
  const routes = ["192.0.2.1", null, "192.0.2.1", "192.0.2.2", "192.0.2.2", "192.0.2.2"];
  let checks = 0;
  const reason = await monitorTunnel({
    signal: new AbortController().signal,
    lanAddress: null,
    pause: async () => {},
    health: async () => true,
    findLan: async () => routes[checks++],
  });
  NodeAssert.equal(reason, "LAN is available again");
  NodeAssert.equal(checks, 6);
});

NodeTest.test(
  "checks the actual HTTP response and environment identity through a live port",
  async (t) => {
    let mode = "healthy";
    const server = NodeHttp.createServer((_request, response) => {
      if (mode === "hung") return;
      if (mode === "error") {
        response.writeHead(503).end();
        return;
      }
      response.end(JSON.stringify({ environmentId: mode === "wrong" ? "other" : "workstation" }));
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}/.well-known/t3/environment`;
    const signal = new AbortController().signal;
    NodeAssert.equal(await probeEnvironment(url, "workstation", signal), true);
    mode = "wrong";
    NodeAssert.equal(await probeEnvironment(url, "workstation", signal), false);
    mode = "error";
    NodeAssert.equal(await probeEnvironment(url, "workstation", signal), false);
    mode = "hung";
    NodeAssert.equal(await probeEnvironment(url, "workstation", signal, 50), false);
  },
);
