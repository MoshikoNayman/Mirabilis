// Homelab Roster reachability: a plain TCP connect to host:port, closed at once.
// No protocol handshake, so it works for any device with an open port.

import net from 'node:net';

// Resolves { reachable, ms }; never rejects.
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

// Probes in parallel; results keep the input order.
export function probeAllHosts(hosts, timeoutMs = 2500) {
  const list = Array.isArray(hosts) ? hosts : [];
  return Promise.all(
    list.map(async (h) => {
      const { reachable, ms } = await probeHost(h.host, h.port, timeoutMs);
      return { id: h.id, reachable, ms };
    })
  );
}
