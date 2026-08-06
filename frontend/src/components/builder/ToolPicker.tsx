import { Wrench } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { useTools } from '@/lib/queries'
import { cn } from '@/lib/utils'

interface ToolPickerProps {
  /** Tool ids currently enabled. */
  value: string[]
  onChange: (next: string[]) => void
  /** Ids the schema allows, from its enum. */
  allowed: string[]
  idPrefix: string
}

/**
 * "Enable or disable tools" is a headline requirement, and a list of raw ids
 * does not tell anyone when a tool is worth enabling — so each row shows the
 * registry's own name and description.
 *
 * It is chosen by property shape (`tools` + array-of-enum-string), not by node
 * kind, so a future kind with a `tools` field gets this for free.
 */
export function ToolPicker({ value, onChange, allowed, idPrefix }: ToolPickerProps) {
  const tools = useTools()

  function toggle(id: string, enabled: boolean) {
    onChange(enabled ? [...new Set([...value, id])] : value.filter((entry) => entry !== id))
  }

  if (tools.isPending) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  // Fall back to the schema's ids if the registry could not be read — the user
  // can still turn tools on, just without the descriptions.
  const rows = allowed.map((id) => {
    const meta = tools.data?.find((tool) => tool.id === id)
    return { id, name: meta?.name ?? id, description: meta?.description ?? '' }
  })

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No tools are registered.</p>
  }

  return (
    <div className="space-y-1">
      {rows.map((tool) => {
        const checked = value.includes(tool.id)
        const inputId = `${idPrefix}-tool-${tool.id}`
        return (
          <label
            key={tool.id}
            htmlFor={inputId}
            className={cn(
              'flex cursor-pointer gap-2.5 rounded-lg border p-2.5 transition-colors',
              checked ? 'border-kind-tool/40 bg-kind-tool/5' : 'hover:bg-muted/60',
            )}
          >
            <Checkbox
              id={inputId}
              checked={checked}
              onCheckedChange={(next) => toggle(tool.id, next === true)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Wrench className="size-3 text-kind-tool" aria-hidden />
                {tool.name}
                <code className="font-mono text-xs font-normal text-muted-foreground">
                  {tool.id}
                </code>
              </span>
              {tool.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {tool.description}
                </span>
              )}
            </span>
          </label>
        )
      })}
    </div>
  )
}
