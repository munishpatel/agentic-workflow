import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Controller,
  useFieldArray,
  useForm,
  type Control,
  type FieldValues,
  type UseFormRegister,
} from 'react-hook-form'
import { Plus, X } from 'lucide-react'
import type { JSONSchema } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { ToolPicker } from '@/components/builder/ToolPicker'
import { describeSchema, emptyItemFor, type FieldDescriptor } from '@/lib/jsonSchema'
import { formatJson } from '@/lib/utils'

/**
 * Renders a config form from a JSON Schema. This component is what makes
 * "adding a node kind needs no frontend change" true — it never mentions a node
 * kind, only the field shapes listed in frontend-plan.md §6.3.
 *
 * The form owns its values while it is mounted and writes through on a debounce;
 * callers remount it (`key={node.id}`) when the subject changes, rather than
 * feeding values back in, which would fight the user's cursor.
 */

const WRITE_DEBOUNCE_MS = 300

interface NodeConfigFormProps {
  schema: JSONSchema
  value: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
  idPrefix: string
  /** Hidden here because a dedicated editor renders them (e.g. tool args). */
  omit?: string[]
  emptyHint?: string
}

export function NodeConfigForm({
  schema,
  value,
  onChange,
  idPrefix,
  omit = [],
  emptyHint,
}: NodeConfigFormProps) {
  const fields = useMemo(
    () => describeSchema(schema).filter((field) => !omit.includes(field.name)),
    [schema, omit],
  )

  const form = useForm<FieldValues>({ defaultValues: value, mode: 'onBlur' })
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const omitRef = useRef(omit)
  omitRef.current = omit

  // Write valid values through on a debounce, so typing a sentence is one
  // history entry per pause rather than one per keystroke.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = form.watch((values) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // Omitted keys are edited elsewhere; emitting the copy this form was
        // mounted with would overwrite whatever that editor has since written.
        const emitted = Object.fromEntries(
          Object.entries(values as Record<string, unknown>).filter(
            ([key]) => !omitRef.current.includes(key),
          ),
        )
        onChangeRef.current(emitted)
      }, WRITE_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      subscription.unsubscribe()
    }
  }, [form])

  if (fields.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {emptyHint ?? 'This node kind has nothing to configure.'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <FieldRenderer
          key={field.name}
          field={field}
          name={field.name}
          control={form.control}
          register={form.register}
          idPrefix={idPrefix}
          error={form.formState.errors[field.name]?.message as string | undefined}
        />
      ))}
    </div>
  )
}

/* ── Field rendering ─────────────────────────────────────────────────────── */

interface FieldRendererProps {
  field: FieldDescriptor
  /** Full react-hook-form path — nested inside array items for sub-forms. */
  name: string
  control: Control<FieldValues>
  register: UseFormRegister<FieldValues>
  idPrefix: string
  error?: string
  compact?: boolean
}

function FieldShell({
  field,
  htmlFor,
  error,
  children,
  compact,
}: {
  field: FieldDescriptor
  htmlFor: string
  error?: string
  children: React.ReactNode
  compact?: boolean
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="flex items-baseline gap-1">
        {field.label}
        {field.required && (
          <span className="text-destructive" aria-label="required">
            *
          </span>
        )}
      </Label>
      {field.description && !compact && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function FieldRenderer({
  field,
  name,
  control,
  register,
  idPrefix,
  error,
  compact,
}: FieldRendererProps) {
  const id = `${idPrefix}-${name}`
  const requiredRule = field.required ? `${field.label} is required.` : false

  switch (field.kind) {
    case 'string':
      return (
        <FieldShell field={field} htmlFor={id} error={error} compact={compact}>
          <Input
            id={id}
            aria-invalid={Boolean(error)}
            {...register(name, { required: requiredRule })}
          />
        </FieldShell>
      )

    case 'textarea':
      return (
        <FieldShell field={field} htmlFor={id} error={error} compact={compact}>
          <Textarea
            id={id}
            rows={compact ? 3 : 6}
            aria-invalid={Boolean(error)}
            {...register(name, { required: requiredRule })}
          />
        </FieldShell>
      )

    case 'number':
      return (
        <FieldShell field={field} htmlFor={id} error={error} compact={compact}>
          <Input
            id={id}
            type="number"
            step={field.integer ? 1 : 'any'}
            min={field.minimum}
            max={field.maximum}
            aria-invalid={Boolean(error)}
            {...register(name, {
              required: requiredRule,
              valueAsNumber: true,
              ...(field.minimum !== undefined
                ? { min: { value: field.minimum, message: `Minimum is ${field.minimum}.` } }
                : {}),
              ...(field.maximum !== undefined
                ? { max: { value: field.maximum, message: `Maximum is ${field.maximum}.` } }
                : {}),
            })}
          />
        </FieldShell>
      )

    case 'boolean':
      return (
        <Controller
          control={control}
          name={name}
          render={({ field: controlled }) => (
            <div className="flex items-start gap-2">
              <Checkbox
                id={id}
                checked={Boolean(controlled.value)}
                onCheckedChange={(next) => controlled.onChange(next === true)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={id}>{field.label}</Label>
                {field.description && (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                )}
              </div>
            </div>
          )}
        />
      )

    case 'select':
      return (
        <Controller
          control={control}
          name={name}
          rules={{ required: requiredRule }}
          render={({ field: controlled }) => (
            <FieldShell field={field} htmlFor={id} error={error} compact={compact}>
              <Select
                value={typeof controlled.value === 'string' ? controlled.value : ''}
                onValueChange={controlled.onChange}
              >
                <SelectTrigger id={id} className="w-full">
                  <SelectValue placeholder={`Choose ${field.label.toLowerCase()}…`} />
                </SelectTrigger>
                <SelectContent>
                  {(field.options ?? []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldShell>
          )}
        />
      )

    case 'multiselect':
      return (
        <Controller
          control={control}
          name={name}
          render={({ field: controlled }) => {
            const selected = Array.isArray(controlled.value) ? (controlled.value as string[]) : []
            const allowed = (field.options ?? []).map((option) => option.value)

            // Property-shape detection, not node-kind detection.
            if (field.name === 'tools') {
              return (
                <div className="grid gap-1.5">
                  <Label>{field.label}</Label>
                  {field.description && (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  )}
                  <ToolPicker
                    value={selected}
                    onChange={controlled.onChange}
                    allowed={allowed}
                    idPrefix={id}
                  />
                </div>
              )
            }

            return (
              <FieldShell field={field} htmlFor={id} error={error} compact={compact}>
                <div className="space-y-1">
                  {(field.options ?? []).map((option) => (
                    <div key={option.value} className="flex items-center gap-2">
                      <Checkbox
                        id={`${id}-${option.value}`}
                        checked={selected.includes(option.value)}
                        onCheckedChange={(next) =>
                          controlled.onChange(
                            next === true
                              ? [...selected, option.value]
                              : selected.filter((entry) => entry !== option.value),
                          )
                        }
                      />
                      <Label htmlFor={`${id}-${option.value}`} className="font-normal">
                        {option.label}
                      </Label>
                    </div>
                  ))}
                </div>
              </FieldShell>
            )
          }}
        />
      )

    case 'stringList':
      return (
        <Controller
          control={control}
          name={name}
          render={({ field: controlled }) => (
            <FieldShell field={field} htmlFor={id} error={error} compact={compact}>
              <StringListEditor
                value={Array.isArray(controlled.value) ? (controlled.value as string[]) : []}
                onChange={controlled.onChange}
                id={id}
                label={field.label}
              />
            </FieldShell>
          )}
        />
      )

    case 'objectList':
      return (
        <ObjectListEditor
          field={field}
          name={name}
          control={control}
          register={register}
          idPrefix={idPrefix}
        />
      )

    case 'json':
      return (
        <Controller
          control={control}
          name={name}
          render={({ field: controlled }) => (
            <JsonEditor
              field={field}
              id={id}
              value={controlled.value}
              onChange={controlled.onChange}
            />
          )}
        />
      )
  }
}

/* ── Editors for the compound shapes ─────────────────────────────────────── */

function StringListEditor({
  value,
  onChange,
  id,
  label,
}: {
  value: string[]
  onChange: (next: string[]) => void
  id: string
  label: string
}) {
  return (
    <div className="space-y-1.5">
      {value.map((entry, index) => (
        <div key={index} className="flex gap-1.5">
          <Input
            id={index === 0 ? id : undefined}
            aria-label={`${label} ${index + 1}`}
            value={entry}
            onChange={(event) =>
              onChange(
                value.map((old, position) => (position === index ? event.target.value : old)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${label} ${index + 1}`}
            onClick={() => onChange(value.filter((_, position) => position !== index))}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, ''])}>
        <Plus aria-hidden />
        Add
      </Button>
    </div>
  )
}

function ObjectListEditor({
  field,
  name,
  control,
  register,
  idPrefix,
}: {
  field: FieldDescriptor
  name: string
  control: Control<FieldValues>
  register: UseFormRegister<FieldValues>
  idPrefix: string
}) {
  const { fields, append, remove } = useFieldArray({ control, name })
  const itemFields = field.itemFields ?? []

  return (
    <div className="grid gap-1.5">
      <Label>{field.label}</Label>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}

      <div className="space-y-2">
        {fields.map((item, index) => (
          <div key={item.id} className="rounded-lg border bg-muted/30 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {field.label.replace(/s$/, '')} {index + 1}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${field.label} ${index + 1}`}
                onClick={() => remove(index)}
              >
                <X aria-hidden />
              </Button>
            </div>
            <div className="space-y-2.5">
              {itemFields.map((itemField) => (
                <FieldRenderer
                  key={itemField.name}
                  field={itemField}
                  name={`${name}.${index}.${itemField.name}`}
                  control={control}
                  register={register}
                  idPrefix={`${idPrefix}-${index}`}
                  compact
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => append(emptyItemFor(itemFields))}
      >
        <Plus aria-hidden />
        Add {field.label.replace(/s$/, '').toLowerCase()}
      </Button>
    </div>
  )
}

/**
 * The honest fallback for a shape the renderer does not model. It only writes
 * through when the text parses, so a half-typed object cannot corrupt config.
 */
function JsonEditor({
  field,
  id,
  value,
  onChange,
}: {
  field: FieldDescriptor
  id: string
  value: unknown
  onChange: (next: unknown) => void
}) {
  const [text, setText] = useState(() => formatJson(value ?? {}))
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{field.label}</Label>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      <Textarea
        id={id}
        rows={5}
        spellCheck={false}
        className="font-mono text-xs"
        value={text}
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          try {
            onChange(JSON.parse(next))
            setError(null)
          } catch {
            setError('Not valid JSON — the last valid value is still saved.')
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
