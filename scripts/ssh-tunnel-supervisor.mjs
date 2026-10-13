/* eslint-disable t3code/no-global-process-runtime -- Standalone installed Node script, without workspace or Effect dependencies. */
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** A live SSH process is not proof that its forwarded application still responds. */
export async function probeEnvironment(url, environmentId, signal, timeoutMs = 4000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: "error",
    });
    if (!response.ok) return false;
    const descriptor = await response.json();
    return (
      typeof descriptor.environmentId === "string" &&
      (!environmentId || descriptor.environmentId === environmentId)
    );
  } catch {
    return false;
  }
}

export function probeSsh(address, signal, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host: address, port: 22, signal });
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Require repeated failures or stable LAN availability before disrupting a session. */
export async function monitorTunnel({
  signal,
  health,
  findLan,
  lanAddress,
  intervalMs = 10000,
  pause = (ms, abortSignal) =>
    NodeTimersPromises.setTimeout(ms, undefined, { signal: abortSignal }),
}) {
  let failures = 0;
  let candidate = null;
  let confirmations = 0;
  while (!signal.aborted) {
    await pause(intervalMs, signal);
    failures = (await health(signal)) ? 0 : failures + 1;
    if (signal.aborted) return "stopped";
    if (failures >= 3) return "application failed three health checks";
    // Do not change between two working LAN addresses. Only leave the fallback.
    if (lanAddress !== null) continue;
    const available = await findLan(signal);
    confirmations = available !== null && available === candidate ? confirmations + 1 : 1;
    candidate = available;
    if (candidate !== null && confirmations >= 3) return "LAN is available again";
  }
  return "stopped";
}

async function stopOwnedProcess(child, closed) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (NodeOS.platform() === "win32") {
    // ProxyJump creates an SSH child too. This PID was captured at NodeChildProcess.spawn.
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    }).catch((error) => {
      if (child.exitCode === null && child.signalCode === null) throw error;
    });
  } else {
    child.kill("SIGTERM");
  }
  await closed;
}

export async function superviseTunnel(options, signal) {
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (!options.logFile) {
      process.stdout.write(line);
      return;
    }
    if (NodeFS.existsSync(options.logFile) && NodeFS.statSync(options.logFile).size > 1024 * 1024) {
      NodeFS.rmSync(`${options.logFile}.previous`, { force: true });
      NodeFS.renameSync(options.logFile, `${options.logFile}.previous`);
    }
    NodeFS.appendFileSync(options.logFile, line);
  };
  const findLan = async (abortSignal) => {
    for (const address of options.lanAddresses) {
      if (abortSignal.aborted) return null;
      if (await probeSsh(address, abortSignal)) return address;
    }
    return null;
  };
  while (!signal.aborted) {
    const lanAddress = await findLan(signal);
    if (signal.aborted) break;
    const args = [
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      `127.0.0.1:${options.localPort}:127.0.0.1:${options.remotePort}`,
      ...(lanAddress === null
        ? []
        : ["-o", `HostName=${lanAddress}`, "-o", "ProxyJump=none", "-p", "22"]),
      options.target,
    ];
    log(`Connecting ${options.target} via ${lanAddress ?? "configured fallback"}`);
    const child = NodeChildProcess.spawn(NodeOS.platform() === "win32" ? "ssh.exe" : "ssh", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const closed = new Promise((resolve) => {
      child.once("exit", (code) => resolve(`SSH exited ${code}`));
      child.once("error", (error) => resolve(`SSH could not start: ${error.message}`));
    });
    child.stderr.on("data", (data) => log(data.toString().trimEnd()));
    const session = new AbortController();
    const sessionSignal = AbortSignal.any([signal, session.signal]);
    try {
      const reason = await Promise.race([
        closed,
        monitorTunnel({
          signal: sessionSignal,
          lanAddress,
          findLan,
          health: (abortSignal) =>
            probeEnvironment(
              `http://127.0.0.1:${options.localPort}/.well-known/t3/environment`,
              options.environmentId,
              abortSignal,
            ),
        }).catch((error) => {
          if (sessionSignal.aborted) return "stopped";
          throw error;
        }),
      ]);
      log(reason);
    } finally {
      session.abort();
      await stopOwnedProcess(child, closed);
    }
    if (!signal.aborted)
      await NodeTimersPromises.setTimeout(2000, undefined, { signal }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const { values } = NodeUtil.parseArgs({
    options: {
      target: { type: "string" },
      "local-port": { type: "string" },
      "remote-port": { type: "string", default: "3773" },
      "lan-addresses": { type: "string", default: "" },
      "environment-id": { type: "string" },
      "log-file": { type: "string" },
    },
  });
  const localPort = Number(values["local-port"]);
  const remotePort = Number(values["remote-port"]);
  if (
    !values.target ||
    ![localPort, remotePort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)
  ) {
    throw new Error(
      "Usage: node ssh-tunnel-supervisor.mjs --target <ssh-alias> --local-port <port> [--lan-addresses <ip,ip>]",
    );
  }
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  await superviseTunnel(
    {
      target: values.target,
      localPort,
      remotePort,
      lanAddresses: values["lan-addresses"].split(",").filter(Boolean),
      environmentId: values["environment-id"],
      logFile: values["log-file"],
    },
    abort.signal,
  );
}
