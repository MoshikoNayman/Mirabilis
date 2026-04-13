import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const ui = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-ui'
});

const mono = JetBrains_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono'
});

export const metadata = {
  title: 'Mirabilis AI',
  description: 'Local ChatGPT-style app with Ollama streaming'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved font + color scheme before hydration to prevent flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var f=localStorage.getItem('mirabilis-font');if(f)document.documentElement.setAttribute('data-font',f);var cs=localStorage.getItem('mirabilis-color-scheme');if(cs&&['dusk','ember','summit'].includes(cs))document.documentElement.setAttribute('data-color-scheme',cs);}catch(e){}` }} />
      </head>
      <body className={`${ui.variable} ${mono.variable}`} suppressHydrationWarning>{children}</body>
    </html>
  );
}
