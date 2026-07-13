// frontend/src/components/shell/usePresence.js
// Polls provider health and exposes a { [providerId]: presenceState } map plus
// the aggregate orb state. Plays a subtle cue when a provider comes online.
'use client';

import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, probeAll, probeOllamaWarmth, aggregatePresence } from '../../lib/presence';
import { playOnline } from '../../lib/sounds';

const POLL_MS = 30000;

export default function usePresence({ streaming = false } = {}) {
  const [map, setMap] = useState(() =>
    Object.fromEntries(PROVIDERS.map((p) => [p.id, 'unknown']))
  );
  // Model Warmth: names of Ollama models currently warm in VRAM.
  const [warm, setWarm] = useState([]);
  const prev = useRef(map);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();

    async function run() {
      try {
        const next = await probeAll({ signal: controller.signal });
        if (!alive) return;
        // Detect transitions to online for the "buddy online" blip.
        const cameOnline = Object.keys(next).some(
          (id) => next[id] === 'online' && prev.current[id] && prev.current[id] !== 'online' && prev.current[id] !== 'unknown'
        );
        prev.current = next;
        setMap(next);
        if (cameOnline) playOnline();
        // Refresh which local models are warm (best-effort, only if Ollama is up).
        if (next.ollama === 'online') {
          const warmModels = await probeOllamaWarmth({ signal: controller.signal });
          if (alive) setWarm(warmModels);
        } else if (alive) {
          setWarm([]);
        }
      } catch {
        /* ignore poll errors */
      }
    }

    run();
    const t = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(t);
    };
  }, []);

  return { map, warm, orbState: aggregatePresence(map, streaming) };
}
