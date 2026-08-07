import { Inbox } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PageHeader } from '@/components/common/PageHeader'
import { useEmails } from '@/lib/queries'
import { formatRelativeTime } from '@/lib/utils'

/**
 * The mock outbox. `send_email` never sends anything — it validates its input
 * and writes here — so this page is the evidence that the tool ran and what it
 * was called with.
 */
export function OutboxPage() {
  const emails = useEmails()

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <PageHeader
        title="Outbox"
        description="Everything the send_email tool has written. Nothing leaves this machine."
      />

      <Alert className="mb-5">
        <Inbox aria-hidden />
        <AlertTitle>Mocked on purpose</AlertTitle>
        <AlertDescription>
          The tool validates the address, subject and body, records the message, and returns a
          confirmation to the model — without a mail server anywhere in the loop.
        </AlertDescription>
      </Alert>

      {emails.isPending && (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      )}

      {emails.isError && <ErrorState error={emails.error} onRetry={() => void emails.refetch()} />}

      {emails.isSuccess && emails.data.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="Nothing sent yet"
          description="Give an agent the send_email tool, then ask it to send something. The message shows up here."
        />
      )}

      {emails.isSuccess && emails.data.length > 0 && (
        <ul className="space-y-3">
          {emails.data.map((email) => (
            <li key={email.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="truncate">{email.subject}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    To <span className="font-mono">{email.to}</span> ·{' '}
                    {formatRelativeTime(email.created_at)}
                  </p>
                </CardHeader>
                <CardContent>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">{email.body}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
