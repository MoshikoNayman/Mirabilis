// frontend/src/components/shell/CommandPalette.jsx
// ⌘K Spotlight-style command palette. Drives theme/scheme/font/sounds directly
// (shared modules) and emits CustomEvents for chat-specific actions so it stays
// decoupled from the ChatApp monolith.
'use client';

import { useMemo, useRef, useState } from 'react';
import { Modal, Kbd } from '../ui/primitives';
import { appStore } from '../../store/useAppStore';
import {
  SCHEMES, SCHEME_META, FONTS, FONT_META, setScheme, setFont, cycleMode, getMode
} from '../../lib/theme';
import { toggleMuted, isMuted } from '../../lib/sounds';

// Fire a DOM event ChatApp can opt into (no-op until wired).
function emit(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* ignore */
  }
}

function fuzzy(query, text) {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.includes(q)) return 2;
  // subsequence match
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

export default function CommandPalette({ open, onTab }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  const commands = useMemo(() => {
    const cmds = [
      { id: 'new-chat', title: 'New chat', hint: 'Start a fresh conversation', icon: '✎', run: () => { onTab?.('chat'); emit('mirabilis:new-chat'); } },
      { id: 'go-chat', title: 'Go to Chat', icon: '💬', run: () => onTab?.('chat') },
      { id: 'go-intel', title: 'Go to IntelLedger', icon: '🗂', run: () => onTab?.('intel') },
      { id: 'search', title: 'Search everything…', hint: 'Chats and providers', icon: '🔍', run: () => appStore.openSearch() },
      { id: 'buddy', title: 'Open Buddy List', icon: '🌼', run: () => appStore.setBuddyOpen(true) },
      { id: 'theme', title: `Toggle appearance (now: ${getMode()})`, icon: '◐', run: () => cycleMode() },
      { id: 'sound', title: isMuted() ? 'Unmute sounds' : 'Mute sounds', icon: '🔔', run: () => { toggleMuted(); } },
      { id: 'web', title: 'Toggle web search', icon: '🌐', run: () => emit('mirabilis:toggle-web-search') }
    ];
    SCHEMES.forEach((s) => cmds.push({
      id: `scheme-${s}`, title: `Theme: ${SCHEME_META[s].label}`, icon: '🎨',
      group: 'Appearance', run: () => setScheme(s)
    }));
    FONTS.forEach((f) => cmds.push({
      id: `font-${f}`, title: `Font: ${FONT_META[f]}`, icon: '🔤',
      group: 'Appearance', run: () => setFont(f)
    }));
    return cmds;
  }, [onTab]);

  const filtered = useMemo(() => {
    return commands
      .map((c) => ({ c, score: fuzzy(query, c.title) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [commands, query]);

  function runAt(idx) {
    const cmd = filtered[idx];
    if (!cmd) return;
    appStore.closeCommand();
    setQuery('');
    setActive(0);
    cmd.run();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    }
  }

  return (
    <Modal open={open} onClose={() => appStore.closeCommand()} align="top" className="max-w-[560px]" labelledBy="cmdk-title">
      <div className="au-chrome au-hairline au-elev-3 overflow-hidden rounded-[var(--r-xl)]">
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <span className="text-[color:var(--text-muted)]">⌘</span>
          <input
            id="cmdk-title"
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            className="w-full bg-transparent text-[length:var(--text-md)] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} className="au-scroll max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">No matching commands</div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
                className={`au-focus flex w-full items-center gap-3 rounded-[var(--r-md)] px-3 py-2 text-left transition ${
                  i === active ? 'bg-[color:var(--hairline)]' : ''
                }`}
              >
                <span className="text-[length:var(--text-md)]">{cmd.icon}</span>
                <span className="flex flex-1 flex-col">
                  <span className="text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{cmd.title}</span>
                  {cmd.hint ? <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{cmd.hint}</span> : null}
                </span>
                {i === active ? <Kbd>↵</Kbd> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
