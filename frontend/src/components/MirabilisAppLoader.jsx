'use client';

import dynamic from 'next/dynamic';

const MirabilisApp = dynamic(() => import('./MirabilisApp'), {
  ssr: false,
  loading: () => null
});

export default function MirabilisAppLoader() {
  return <MirabilisApp />;
}
