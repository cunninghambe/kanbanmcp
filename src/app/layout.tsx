import type { Metadata } from 'next'
import './globals.css'
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'KanbanMCP',
  description: 'AI-powered kanban board',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}        {/* <!-- AUTOGENY_NAV_START --> */}
        <Script src="/autogeny-nav.js" strategy="afterInteractive" />
        {/* <!-- AUTOGENY_NAV_END --> */}
        </body>
    </html>
  )
}
