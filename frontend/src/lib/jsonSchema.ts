import type { JSONSchema } from '@/types/api'
import { humanise } from '@/lib/utils'

/**
 * Turns a JSON Schema into a flat list of field descriptors the form renderer
 * can switch on. Keeping the interpretation here — rather than inside the form
 * — means the mapping is testable and the component stays a renderer.
 *
 * Only the shapes listed in frontend-plan.md §6.3 are supported. Anything else
 * becomes a `json` field: a visible, honest fallback beats silently dropping a
 * config key the backend needs.
 */

export type FieldKind =
  | 'string'
  | 'textarea'
  | 'select'
  | 'number'
  | 'boolean'
  | 'multiselect'
  | 'stringList'
  | 'objectList'
  | 'json'

export interface FieldOption {
  value: string
  label: string
}

export interface FieldDescriptor {
  name: string
  label: string
  description?: string
  required: boolean
  kind: FieldKind
  schema: JSONSchema
  default?: unknown
  /** select / multiselect */
  options?: FieldOption[]
  /** number */
  minimum?: number
  maximum?: number
  integer?: boolean
  /** objectList — the sub-form for one array item. */
  itemFields?: FieldDescriptor[]
}

/** Pydantic emits nested models as `$ref` into `$defs`. */
function resolveRef(schema: JSONSchema, root: JSONSchema): JSONSchema {
  if (!schema.$ref) return schema
  const match = /^#\/\$defs\/(.+)$/.exec(schema.$ref)
  const name = match?.[1]
  if (!name) return schema
  return root.$defs?.[name] ?? schema
}

/**
 * `Optional[str]` becomes `anyOf: [{type: string}, {type: null}]`. Unwrap to the
 * one meaningful branch so an optional field still renders as its real control.
 */
function unwrapNullable(schema: JSONSchema): JSONSchema {
  const branches = schema.anyOf ?? schema.oneOf
  if (!branches) return schema
  const real = branches.filter((branch) => branch.type !== 'null')
  const only = real.length === 1 ? real[0] : undefined
  if (!only) return schema
  // Keep the outer title/description/default — Pydantic puts them there.
  return {
    ...only,
    ...stripUndefined({
      title: schema.title,
      description: schema.description,
      default: schema.default,
    }),
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

const TEXTAREA_NAMES = /instruction|prompt|body|message|content|template/i
const LONG_DESCRIPTION = 100

function isEnumOfStrings(schema: JSONSchema): boolean {
  return (
    schema.type === 'string' &&
    Array.isArray(schema.enum) &&
    schema.enum.every((v) => typeof v === 'string')
  )
}

function optionsFrom(schema: JSONSchema): FieldOption[] {
  return (schema.enum ?? []).map((value) => ({
    value: String(value),
    label: humanise(String(value)),
  }))
}

function kindOf(name: string, schema: JSONSchema, root: JSONSchema): FieldKind {
  if (schema.type === 'string') {
    if (Array.isArray(schema.enum)) return 'select'
    if (schema['x-ui'] === 'textarea') return 'textarea'
    if (TEXTAREA_NAMES.test(name)) return 'textarea'
    if ((schema.description?.length ?? 0) > LONG_DESCRIPTION) return 'textarea'
    return 'string'
  }
  if (schema.type === 'integer' || schema.type === 'number') return 'number'
  if (schema.type === 'boolean') return 'boolean'
  if (schema.type === 'array') {
    const items = schema.items ? unwrapNullable(resolveRef(schema.items, root)) : undefined
    if (!items) return 'json'
    if (isEnumOfStrings(items)) return 'multiselect'
    if (items.type === 'string') return 'stringList'
    if (items.type === 'object') return 'objectList'
    return 'json'
  }
  return 'json'
}

function describeProperty(
  name: string,
  raw: JSONSchema,
  required: boolean,
  root: JSONSchema,
): FieldDescriptor {
  const schema = unwrapNullable(resolveRef(raw, root))
  const kind = kindOf(name, schema, root)

  const field: FieldDescriptor = {
    name,
    label: schema.title ?? humanise(name),
    required,
    kind,
    schema,
    ...stripUndefined({ description: schema.description, default: schema.default }),
  }

  if (kind === 'select') field.options = optionsFrom(schema)

  if (kind === 'multiselect') {
    const items = schema.items ? unwrapNullable(resolveRef(schema.items, root)) : {}
    field.options = optionsFrom(items)
  }

  if (kind === 'number') {
    field.integer = schema.type === 'integer'
    if (schema.minimum !== undefined) field.minimum = schema.minimum
    if (schema.maximum !== undefined) field.maximum = schema.maximum
  }

  if (kind === 'objectList' && schema.items) {
    field.itemFields = describeSchema(resolveRef(schema.items, root), root)
  }

  return field
}

/** The fields of an object schema, in declaration order. */
export function describeSchema(schema: JSONSchema, root: JSONSchema = schema): FieldDescriptor[] {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  return Object.entries(properties).map(([name, property]) =>
    describeProperty(name, property, required.has(name), root),
  )
}

/**
 * A blank value for a field, used when adding a row to a repeatable sub-form.
 * `undefined` would make react-hook-form treat the input as uncontrolled.
 */
export function emptyValueFor(field: FieldDescriptor): unknown {
  if (field.default !== undefined) return structuredClone(field.default)
  switch (field.kind) {
    case 'boolean':
      return false
    case 'number':
      return field.minimum ?? 0
    case 'multiselect':
    case 'stringList':
    case 'objectList':
      return []
    case 'json':
      return {}
    case 'select':
      return field.options?.[0]?.value ?? ''
    default:
      return ''
  }
}

export function emptyItemFor(fields: FieldDescriptor[]): Record<string, unknown> {
  const item: Record<string, unknown> = {}
  for (const field of fields) item[field.name] = emptyValueFor(field)
  return item
}
