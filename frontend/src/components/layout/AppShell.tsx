import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Inbox, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/', label: 'Workflows', icon: Workflow, end: true },
  { to: '/outbox', label: 'Outbox', icon: Inbox, end: false },
]

/**
 * Global chrome: a thin header plus a `min-h-0` main region. Pages that fill the
 * viewport (builder, chat) depend on that `min-h-0` — without it a flex child
 * refuses to shrink and the canvas grows the page instead of scrolling inside it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const usingMocks = import.meta.env.VITE_USE_MOCKS === 'true'

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b bg-background px-4">
        <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Workflow className="size-3.5" aria-hidden />
          </span>
          Workflow Studio
        </NavLink>

        <nav aria-label="Main" className="flex items-center gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  isActive && 'bg-muted text-foreground',
                )
              }
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        {usingMocks && (
          <Badge variant="secondary" className="ml-auto font-normal" title="VITE_USE_MOCKS=true">
            Mock API
          </Badge>
        )}
      </header>

      <main className="min-h-0 flex-1">{children}</main>
    </div>
  )
}
