// backend/src/homelab.js
// Reachability probes for the Homelab Roster. Opens a plain TCP socket to a
// host:port and closes it the instant the connection is established - this is a
// lightweight "is it up" check (like a mini port knock), not an SSH handshake,
// so it works for routers, NAS boxes, servers, and the Raspberry Pi alike.

import net from 'node:net';

// Probe a single host. Resolves { reachable, ms } - never rejects.
export function probeHost(host, port, timeoutMs = 2500) {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ reachable, ms: Date.now() - started });
    };

    const socket = new net.Socket();
    socket.setTimeout(Math.max(250, Number(timeoutMs) || 2500));
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(Number(port) || 22, String(host));
    } catch {
      finish(false);
    }
  });
}

// Probe every host in the list in parallel. Returns an array of
// { id, reachable, ms } in the same order as the input.
export function probeAllHosts(hosts, timeoutMs = 2500) {
  const list = Array.isArray(hosts) ? hosts : [];
  return Promise.all(
    list.map(async (h) => {
      const { reachable, ms } = await probeHost(h.host, h.port, timeoutMs);
      return { id: h.id, reachable, ms };
    })
  );
}
