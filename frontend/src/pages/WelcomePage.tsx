import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Inbox, Mail, MessagesSquare, Plus, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { NewWorkflowDialog, type NewWorkflowValues } from '@/components/workflow/NewWorkflowDialog'
import { describeError } from '@/lib/client'
import { useCreateWorkflow, useProviders } from '@/lib/queries'
import { workflowInputFromDialog } from '@/lib/workflowDefaults'

/**
 * Lucide removed its brand icons, so the two marks are inlined. They are
 * filled glyphs rather than strokes, which is how both brands specify them —
 * a stroked approximation reads as a generic shape at 14px.
 */
function GithubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function LinkedinMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z" />
    </svg>
  )
}

const CONTACTS = [
  {
    href: 'mailto:munishpatel1513@gmail.com',
    icon: Mail,
    label: 'munishpatel1513@gmail.com',
    srLabel: 'Email',
  },
  {
    href: 'https://www.linkedin.com/in/munishpatel',
    icon: LinkedinMark,
    label: 'LinkedIn',
    srLabel: 'LinkedIn profile',
  },
  {
    href: 'https://www.github.com/munishpatel',
    icon: GithubMark,
    label: 'GitHub',
    srLabel: 'GitHub profile',
  },
]

const FEATURES = [
  {
    to: '/workflows',
    icon: Workflow,
    title: 'Visual canvas',
    description: 'Drag nodes onto the graph and wire them together to shape how an agent behaves.',
  },
  {
    to: '/workflows',
    icon: MessagesSquare,
    title: 'Chat preview',
    description: 'Run a workflow as a live conversation before it ever reaches a real user.',
  },
  {
    to: '/outbox',
    icon: Inbox,
    title: 'Delivery outbox',
    description: 'See every message a workflow sent, replayed exactly as it went out.',
  },
]

export function WelcomePage() {
  const navigate = useNavigate()
  const providers = useProviders()
  const createWorkflow = useCreateWorkflow()
  const [dialogOpen, setDialogOpen] = useState(false)

  function handleCreate(values: NewWorkflowValues) {
    const provider = providers.data?.[0]
    createWorkflow.mutate(workflowInputFromDialog(values, provider), {
      onSuccess: (workflow) => {
        setDialogOpen(false)
        toast.success(`Created “${workflow.name}”`)
        void navigate(`/workflows/${workflow.id}/edit`)
      },
      onError: (error) => {
        const { title, description } = describeError(error)
        toast.error(title, { description })
      },
    })
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-16 text-center">
      <h1 className="text-5xl font-semibold tracking-tight text-balance">Workflow Studio</h1>
      <p className="mt-4 max-w-xl text-lg text-muted-foreground text-balance">
        A full featured visual builder for agent workflows — create, test, and ship at the speed of
        drag &amp; drop.
      </p>

      <Button size="lg" className="mt-8" onClick={() => setDialogOpen(true)}>
        <Plus aria-hidden />
        New Workflow
      </Button>

      <div className="mt-16 rounded-xl border bg-card px-8 py-10 text-left">
        <p className="text-sm font-semibold text-primary">Drag. Drop. Ship faster.</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight">Visual Canvas</p>
        <p className="mt-3 max-w-lg text-sm text-muted-foreground">
          Compose nodes for models, tools, and control flow on one graph, then connect them by
          drawing edges between handles — no config file required.
        </p>
      </div>

      <div className="mt-10 grid w-full gap-4 text-left sm:grid-cols-3">
        {FEATURES.map(({ to, icon: Icon, title, description }) => (
          <Link key={title} to={to} className="block rounded-xl focus-visible:outline-none">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <CardTitle className="mt-2">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <footer className="mt-20 w-full border-t pt-8">
        <p className="text-sm text-muted-foreground">
          Built and designed by <span className="font-medium text-foreground">Munish Patel</span>
        </p>
        <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {CONTACTS.map(({ href, icon: Icon, label, srLabel }) => (
            <li key={label}>
              <a
                href={href}
                {...(href.startsWith('http')
                  ? { target: '_blank', rel: 'noreferrer noopener' }
                  : {})}
                className="flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="sr-only">{srLabel}</span>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </footer>

      <NewWorkflowDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        pending={createWorkflow.isPending}
      />
    </div>
  )
}
