// frontend/src/components/shell/TabSwitch.jsx
// The Chat / Ledger view switch, sitting beside the wordmark in each view's
// header. It dispatches a shell event so MirabilisApp (which owns the active
// tab) flips the view - keeping the top-right dock uncluttered.
'use client';

import { SegmentedControl } from '../ui/primitives';

export default function TabSwitch({ active = 'chat' }) {
  return (
    <SegmentedControl
      size="sm"
      value={active === 'intel' ? 'intel' : 'chat'}
      onChange={(v) => {
        try {
          window.dispatchEvent(new CustomEvent('mirabilis:set-tab', { detail: { tab: v } }));
        } catch {
          /* ignore */
        }
      }}
      options={[
        { value: 'chat', label: 'Chat' },
        { value: 'intel', label: 'Ledger' }
      ]}
    />
  );
}
