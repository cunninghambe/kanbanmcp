'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface HeaderProps {
  title?: string
  breadcrumbs?: { label: string; href?: string }[]
}

export function Header({ title, breadcrumbs }: HeaderProps) {
  const pathname = usePathname()

  const defaultTitle = (() => {
    if (pathname === '/dashboard') return 'Dashboard'
    if (pathname.startsWith('/settings')) return 'Settings'
    if (pathname.startsWith('/activity')) return 'Activity'
    if (pathname.startsWith('/board/')) return 'Board'
    if (pathname.startsWith('/sprints/')) return 'Sprints'
    return 'KanbanMCP'
  })()

  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center px-6 gap-3">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav className="flex items-center gap-1 text-sm">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-slate-400">/</span>}
              {crumb.href ? (
                <Link href={crumb.href} className="text-slate-500 hover:text-slate-900 transition-colors">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-slate-900 font-medium">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : (
        <h2 className="text-lg font-semibold text-slate-900">{title ?? defaultTitle}</h2>
      )}
    </header>
  )
}
