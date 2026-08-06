import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Inbox, RotateCcw, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { clearAllChatSessions } from '@/hooks/useChatSession'
import { cn } from '@/lib/utils'

/**
 * Puts the seeded workflows back. Without it, deleting every workflow leaves a
 * demo with no way home short of clearing site data.
 *
 * The mock layer is imported lazily so app code keeps no static dependency on
 * it — deleting `src/mocks` in phase 6 must not break the shell.
 */
async function resetDemoData() {
  clearAllChatSessions()
  const { mockDb } = await import('@/mocks/db')
  mockDb.reset()
  window.location.assign('/')
}

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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto gap-1.5 text-muted-foreground"
                title="The API is served by MSW in the browser (VITE_USE_MOCKS=true)"
              >
                <Badge variant="secondary" className="font-normal">
                  Mock API
                </Badge>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Every request is answered in the browser. Workflows persist in localStorage, chats
                in sessionStorage.
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={resetDemoData}>
                <RotateCcw aria-hidden />
                Reset demo data
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      <main className="min-h-0 flex-1">{children}</main>
    </div>
  )
}
