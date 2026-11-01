// Chat / Ledger view switch beside the header wordmark. It dispatches a shell
// event; MirabilisApp owns the active tab.
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
