import { describe, expect, it } from 'vitest'
import type { JSONSchema } from '@/types/api'
import { NODE_KINDS, TOOLS } from '@/mocks/fixtures'
import { describeSchema, emptyItemFor } from './jsonSchema'

const kind = (name: string) => NODE_KINDS.find((spec) => spec.kind === name)!
const byName = <T extends { name: string }>(fields: T[], name: string) =>
  fields.find((field) => field.name === name)

describe('describeSchema — the shapes the plan promises to support', () => {
  const agent = describeSchema(kind('agent').config_schema)

  it('renders a long instruction as a textarea and marks it required', () => {
    expect(byName(agent, 'instruction')).toMatchObject({
      kind: 'textarea',
      required: true,
      label: 'Instruction',
    })
  })

  it('renders array-of-enum-string as a multiselect with its options', () => {
    const tools = byName(agent, 'tools')
    expect(tools?.kind).toBe('multiselect')
    expect(tools?.options?.map((option) => option.value)).toEqual([
      'calculator',
      'web_search',
      'send_email',
      'current_datetime',
    ])
  })

  it('carries numeric bounds and integer-ness through', () => {
    expect(byName(agent, 'max_tool_iterations')).toMatchObject({
      kind: 'number',
      integer: true,
      minimum: 1,
      maximum: 10,
      default: 5,
    })
  })

  it('renders a string enum as a select', () => {
    const tool = describeSchema(kind('tool').config_schema)
    expect(byName(tool, 'tool_id')).toMatchObject({ kind: 'select', required: true })
  })

  it('renders array-of-object as a repeatable sub-form', () => {
    const router = describeSchema(kind('router').config_schema)
    const routes = byName(router, 'routes')
    expect(routes?.kind).toBe('objectList')
    expect(routes?.itemFields?.map((field) => field.name)).toEqual(['label', 'description'])
    expect(byName(routes?.itemFields ?? [], 'description')?.kind).toBe('textarea')
  })

  it('returns no fields for a kind with no config', () => {
    expect(describeSchema(kind('input').config_schema)).toEqual([])
  })
})

describe('describeSchema — shapes it has to cope with rather than support', () => {
  it('falls back to a raw JSON editor for anything unrecognised', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { weird: { type: 'array', items: { type: 'array' } } },
    }
    expect(describeSchema(schema)[0]).toMatchObject({ kind: 'json' })
  })

  it('unwraps Optional[str] and keeps the outer title', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        note: { title: 'Note', anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    }
    expect(describeSchema(schema)[0]).toMatchObject({ kind: 'string', label: 'Note' })
  })

  it('resolves a $ref into $defs for a nested model', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { route: { $ref: '#/$defs/Route' } },
      $defs: {
        Route: {
          type: 'object',
          properties: { label: { type: 'string' } },
        },
      },
    }
    // A bare nested object is not one of the supported shapes, but resolving the
    // ref means it is reported as an object rather than an empty mystery.
    expect(describeSchema(schema)[0]?.schema.type).toBe('object')
  })

  it('humanises a property name when the schema has no title', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { max_tool_iterations: { type: 'integer' } },
    }
    expect(describeSchema(schema)[0]?.label).toBe('Max tool iterations')
  })

  it('reads a tool input schema the same way as a node config schema', () => {
    const search = TOOLS.find((tool) => tool.id === 'web_search')!
    const fields = describeSchema(search.input_schema)
    expect(byName(fields, 'query')).toMatchObject({ kind: 'string', required: true })
    expect(byName(fields, 'max_results')).toMatchObject({ kind: 'number', required: false })
  })
})

describe('emptyItemFor', () => {
  it('builds a blank row for a repeatable sub-form', () => {
    const routes = describeSchema(kind('router').config_schema)[0]
    expect(emptyItemFor(routes?.itemFields ?? [])).toEqual({ label: '', description: '' })
  })
})
