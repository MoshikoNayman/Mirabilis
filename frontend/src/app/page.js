'use client';

import dynamic from 'next/dynamic';

const MirabilisApp = dynamic(() => import('../components/MirabilisApp'), {
  ssr: false
});

export default function HomePage() {
  return <MirabilisApp />;
}
