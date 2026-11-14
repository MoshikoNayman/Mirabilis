// One search across chats and providers, grouped with previews; Enter opens the
// first match.
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Kbd, PresenceDot, Spinner, SearchIcon, ChatIcon } from '../ui/primitives';
import { appStore } from '../../store/useAppStore';
import { getJSON } from '../../lib/api';
import { PROVIDERS } from '../../lib/presence';

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function normalizeChats(payload) {
  const list = Array.isArray(payload) ? payload : payload?.chats || payload?.items || [];
  return list.map((c) => ({
    id: c.id || c.chatId || c._id,
    title: c.title || c.name || 'Untitled chat',
    preview: c.preview || (Array.isArray(c.messages) ? c.messages[c.messages.length - 1]?.content : '') || ''
  }));
}

export default function OmniSearch({ open, presence, onPickProvider }) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 180);
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    getJSON('/api/chats')
      .then((p) => setChats(normalizeChats(p)))
      .catch(() => setChats([]))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const q = debounced.toLowerCase().trim();

  const chatResults = useMemo(() => {
    if (!q) return chats.slice(0, 6);
    return chats
      .filter((c) => `${c.title} ${c.preview}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [chats, q]);

  const providerResults = useMemo(() => {
    if (!q) return [];
    return PROVIDERS.filter((p) => p.label.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 5);
  }, [q]);

  function openChat(c) {
    appStore.closeSearch();
    try {
      window.dispatchEvent(new CustomEvent('mirabilis:open-chat', { detail: { id: c.id } }));
    } catch {
      /* ignore */
    }
  }

  function openProvider(p) {
    appStore.closeSearch();
    onPickProvider?.(p);
  }

  // Flat list so arrow keys move one highlight across all groups, as in CommandPalette.
  const flat = useMemo(() => [
    ...chatResults.map((c) => ({ type: 'chat', item: c })),
    ...providerResults.map((p) => ({ type: 'provider', item: p })),
  ], [chatResults, providerResults]);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  useEffect(() => { setActive(0); }, [flat]);
  useEffect(() => {
    listRef.current?.querySelectorAll('button')[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function openFlat(i) {
    const f = flat[i];
    if (!f) return;
    if (f.type === 'chat') openChat(f.item);
    else openProvider(f.item);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); openFlat(active); }
  }

  return (
    <Modal open={open} onClose={() => appStore.closeSearch()} align="top" className="max-w-[600px]" labelledBy="omni-title">
      <div className="au-chrome au-hairline au-elev-3 overflow-hidden rounded-[var(--r-xl)]">
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <span className="text-[color:var(--text-muted)]"><SearchIcon size={15} /></span>
          <input
            id="omni-title"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search"
            className="w-full bg-transparent text-[length:var(--text-md)] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
          />
          {loading ? <Spinner /> : <Kbd>Esc</Kbd>}
        </div>
        <div ref={listRef} className="au-scroll max-h-[56vh] overflow-y-auto p-1.5">
          {chatResults.length > 0 && (
            <Section title="Chats">
              {chatResults.map((c, i) => (
                <Row key={c.id} icon={<ChatIcon size={15} />} title={c.title} sub={c.preview} active={active === i} onClick={() => openChat(c)} />
              ))}
            </Section>
          )}
          {providerResults.length > 0 && (
            <Section title="Providers">
              {providerResults.map((p, i) => (
                <Row
                  key={p.id}
                  leading={<PresenceDot presence={(presence?.[p.id] === 'unknown' ? 'offline' : presence?.[p.id]) || 'offline'} />}
                  title={p.label}
                  sub={p.scope === 'local' ? 'Local' : 'Cloud'}
                  active={active === chatResults.length + i}
                  onClick={() => openProvider(p)}
                />
              ))}
            </Section>
          )}
          {!loading && chatResults.length === 0 && providerResults.length === 0 && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              {q ? 'No matches' : 'No chats yet'}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-1">
      <div className="px-3 pb-1 pt-2 text-[length:var(--text-2xs)] font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ icon, leading, title, sub, onClick, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`au-focus flex w-full items-center gap-3 rounded-[var(--r-md)] px-3 py-2 text-left transition hover:bg-[color:var(--hairline)] ${active ? 'bg-[color:var(--hairline)]' : ''}`}
    >
      {leading || <span className="flex w-4 justify-center text-[color:var(--text-muted)]">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{title}</span>
        {sub ? <span className="truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{sub}</span> : null}
      </span>
    </button>
  );
}
