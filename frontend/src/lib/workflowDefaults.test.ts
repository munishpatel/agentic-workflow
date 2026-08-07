import { describe, expect, it } from 'vitest'
import { workflowInputFromDialog, type NewWorkflowValues } from '@/lib/workflowDefaults'

const BASE: NewWorkflowValues = {
  name: '  Research assistant  ',
  description: 'Looks things up.',
  useDefaults: true,
  systemPrompt: '',
  toolsEnabled: false,
  tools: [],
}

function agentConfig(values: NewWorkflowValues) {
  const input = workflowInputFromDialog(values, { id: 'anthropic', models: ['claude-sonnet-5'] })
  const agent = input.nodes.find((node) => node.kind === 'agent')
  return { input, config: agent?.config as { tools: string[] } }
}

describe('workflowInputFromDialog', () => {
  it('trims the name and takes the provider’s first model', () => {
    const { input } = agentConfig(BASE)
    expect(input.name).toBe('Research assistant')
    expect(input.provider).toBe('anthropic')
    expect(input.model).toBe('claude-sonnet-5')
  })

  it('carries the system prompt and tools through when defaults are declined', () => {
    const { input, config } = agentConfig({
      ...BASE,
      useDefaults: false,
      systemPrompt: 'Be terse.',
      toolsEnabled: true,
      tools: ['calculator', 'web_search'],
    })
    expect(input.system_prompt).toBe('Be terse.')
    expect(config.tools).toEqual(['calculator', 'web_search'])
  })

  it('ignores the configuration entirely when defaults are kept', () => {
    // Typing a prompt and then ticking "use defaults" must not half-apply it.
    const { input, config } = agentConfig({
      ...BASE,
      useDefaults: true,
      systemPrompt: 'Be terse.',
      toolsEnabled: true,
      tools: ['calculator'],
    })
    expect(input.system_prompt).not.toBe('Be terse.')
    expect(config.tools).toEqual([])
  })

  it('drops the selection when the tools switch is off', () => {
    const { config } = agentConfig({
      ...BASE,
      useDefaults: false,
      toolsEnabled: false,
      tools: ['calculator'],
    })
    expect(config.tools).toEqual([])
  })

  it('falls back to the default prompt rather than saving an empty one', () => {
    const { input } = agentConfig({ ...BASE, useDefaults: false, systemPrompt: '   ' })
    expect(input.system_prompt?.length).toBeGreaterThan(0)
  })

  it('still produces a runnable input → agent → output graph', () => {
    const { input } = agentConfig({ ...BASE, useDefaults: false, systemPrompt: 'Be terse.' })
    expect(input.nodes.map((node) => node.kind)).toEqual(['input', 'agent', 'output'])
    expect(input.edges).toHaveLength(2)
  })
})
