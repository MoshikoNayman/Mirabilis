// Main app wrapper: ChatApp under the Aurora shell chrome

'use client';

import { useEffect } from 'react';
import ChatApp from './ChatApp';
import AppErrorBoundary from './ui/AppErrorBoundary';
import AuroraChrome from './shell/AuroraChrome';
import { publishGoDark } from '../store/useAppStore';

export default function MirabilisApp() {
  // Electron main checks for updates only once told Go Dark is off, so report on load.
  useEffect(() => { publishGoDark(); }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Aurora shell chrome: dock, command palette, omni-search, buddy list */}
      <AuroraChrome />

      {/* Content area */}
      <div className="h-full w-full overflow-hidden">
        <AppErrorBoundary>
          <ChatApp />
        </AppErrorBoundary>
      </div>
    </div>
  );
}
