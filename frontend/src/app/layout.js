import './globals.css';
import '../design/tokens.css';

export const metadata = {
  title: 'Mirabilis AI',
  description: 'Local-first AI assistant by Moshiko Nayman'
};

export const viewport = {
  width: 'device-width',
  initialScale: 1
};

// Applies the saved theme/scheme/font before first paint so there is no flash
// of the wrong theme. Uses the SAME localStorage keys as the in-app controls
// (see src/lib/theme.js + ChatApp.jsx).
const THEME_BOOT = `(function(){try{
var d=document.documentElement,ls=window.localStorage;
var mode=ls.getItem('local-ai-theme-mode')||'auto';
var scheme=ls.getItem('mirabilis-color-scheme')||'mirabilis';
var font=ls.getItem('mirabilis-font')||'jakarta';
var dark=mode==='dark'||(mode==='auto'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
d.classList.toggle('dark',dark);
if(['mirabilis','arctic','ember','summit'].includes(scheme)&&scheme!=='mirabilis')d.setAttribute('data-color-scheme',scheme);else d.removeAttribute('data-color-scheme');
if(['jakarta','system','tahoma'].includes(font)&&font!=='jakarta')d.setAttribute('data-font',font);else d.removeAttribute('data-font');
}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body
        suppressHydrationWarning
        style={{
          '--font-ui':
            "'SF Pro Text',-apple-system,BlinkMacSystemFont,'Inter','Plus Jakarta Sans','Avenir Next','Segoe UI',system-ui,sans-serif",
          '--font-mono':
            "'SF Mono','JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace"
        }}
      >
        {children}
      </body>
    </html>
  );
}
