import { useShallow } from 'zustand/react/shallow'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useDebouncedCommit } from '@/hooks/useDebouncedCommit'
import { useProviders } from '@/lib/queries'
import { useEditorStore } from '@/store/editorStore'

export function WorkflowMetaForm() {
  const providers = useProviders()
  const { meta, setMeta } = useEditorStore(
    useShallow((state) => ({ meta: state.meta, setMeta: state.setMeta })),
  )

  const [name, setName] = useDebouncedCommit(meta.name, (next) => setMeta('name', next))
  const [description, setDescription] = useDebouncedCommit(meta.description, (next) =>
    setMeta('description', next),
  )
  const [systemPrompt, setSystemPrompt] = useDebouncedCommit(meta.system_prompt, (next) =>
    setMeta('system_prompt', next),
  )

  const provider = providers.data?.find((entry) => entry.id === meta.provider)
  // If the saved model is not in the list (an older workflow, say), still offer
  // it rather than silently switching the workflow to a different model.
  const models = provider?.models.includes(meta.model)
    ? provider.models
    : [meta.model, ...(provider?.models ?? [])].filter(Boolean)

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor="meta-name">Name</Label>
        <Input id="meta-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="meta-description">Description</Label>
        <Textarea
          id="meta-description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="meta-provider">Provider</Label>
        <Select
          value={meta.provider}
          onValueChange={(next) => {
            setMeta('provider', next)
            // Models are provider-specific, so keep the pair consistent.
            const first = providers.data?.find((entry) => entry.id === next)?.models[0]
            if (first) setMeta('model', first)
          }}
        >
          <SelectTrigger id="meta-provider" className="w-full">
            <SelectValue placeholder="Choose a provider…" />
          </SelectTrigger>
          <SelectContent>
            {(providers.data ?? []).map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="meta-model">Model</Label>
        <Select value={meta.model} onValueChange={(next) => setMeta('model', next)}>
          <SelectTrigger id="meta-model" className="w-full">
            <SelectValue placeholder="Choose a model…" />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model} value={model} className="font-mono text-xs">
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="meta-system-prompt">System prompt</Label>
        <p className="text-xs text-muted-foreground">
          The graph-wide persona. Each agent node adds its own instruction on top.
        </p>
        <Textarea
          id="meta-system-prompt"
          rows={6}
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
        />
      </div>
    </div>
  )
}
