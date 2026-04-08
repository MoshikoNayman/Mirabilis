import dynamic from 'next/dynamic';

const ChatApp = dynamic(() => import('../components/ChatApp'), {
  ssr: false
});

export default function HomePage() {
  return <ChatApp />;
}
