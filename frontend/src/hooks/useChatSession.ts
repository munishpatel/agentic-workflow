import { useEffect, useState } from 'react'
import type { ChatMessage } from '@/types/ui'

const KEY_PREFIX = 'workflow-studio:chat:'

function load(workflowId: string): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + workflowId)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // A message left mid-flight when the tab closed can never resolve.
    return (parsed as ChatMessage[]).filter((message) => message.status !== 'pending')
  } catch {
    return []
  }
}

function save(workflowId: string, messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(KEY_PREFIX + workflowId, JSON.stringify(messages))
  } catch {
    // Over quota (event logs are chunky) — the session simply stops persisting.
  }
}

/** Wipes every workflow's transcript — used by the demo-data reset. */
export function clearAllChatSessions() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(KEY_PREFIX)) sessionStorage.removeItem(key)
    }
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Chat turns survive a refresh, per workflow, for the life of the tab.
 *
 * The workflow id is held *inside* the state rather than compared in an effect:
 * switching workflows must swap the transcript in the same render that swaps
 * the id, or the save effect writes the previous conversation under the new
 * workflow's key.
 */
export function useChatSession(workflowId: string) {
  const [state, setState] = useState(() => ({ id: workflowId, messages: load(workflowId) }))

  if (state.id !== workflowId) {
    setState({ id: workflowId, messages: load(workflowId) })
  }

  useEffect(() => {
    save(state.id, state.messages)
  }, [state])

  function setMessages(update: (previous: ChatMessage[]) => ChatMessage[]) {
    setState((previous) => ({ id: previous.id, messages: update(previous.messages) }))
  }

  function clear() {
    setState((previous) => ({ id: previous.id, messages: [] }))
  }

  const messages = state.id === workflowId ? state.messages : []
  return { messages, setMessages, clear }
}
