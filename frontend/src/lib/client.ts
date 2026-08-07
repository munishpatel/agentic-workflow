/**
 * The single place the frontend talks to the network.
 *
 * Every non-2xx response from the backend has one shape (frontend-plan.md §3.7):
 *   { "error": { "code": string, "message": string, "details"?: unknown } }
 * so every failure reaching the UI is an `ApiError` with a machine-readable
 * `code`. Components branch on the code, never on the message text.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

export class ApiError extends Error {
  status: number
  code: string
  details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = (value as { error: unknown }).error
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (isApiErrorBody(body)) {
    return new ApiError(response.status, body.error.code, body.error.message, body.error.details)
  }
  return new ApiError(
    response.status,
    'http_error',
    `Request failed with status ${response.status}`,
    body,
  )
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, 'network_error', 'Could not reach the server. Is the backend running?')
  }

  if (!response.ok) throw await toApiError(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PUT', body, signal }),
  delete: <T = void>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: 'DELETE', signal }),
}

/**
 * Turns a failure into something a user can act on. Codes listed in §3.7 get a
 * tailored sentence; everything else falls back to the server's own message,
 * which is written for humans by the backend.
 */
export function describeError(error: unknown): { title: string; description?: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Something went wrong',
      description: error instanceof Error ? error.message : undefined,
    }
  }
  switch (error.code) {
    case 'missing_api_key':
      return {
        title: 'No LLM credential configured',
        description: 'Set ANTHROPIC_API_KEY in backend/.env and restart the backend.',
      }
    case 'refusal':
      return {
        title: 'The model declined to answer',
        description: error.message,
      }
    case 'rate_limit':
      return {
        title: 'Rate limited by the provider',
        description: 'Too many requests in a short window. Wait a moment and try again.',
      }
    case 'iteration_limit':
    case 'node_limit':
      return {
        title: 'The workflow ran too long',
        description: `${error.message} Check for a loop, or lower the agent's max tool iterations.`,
      }
    case 'validation_error':
      return { title: 'The workflow is not valid', description: error.message }
    case 'network_error':
      return { title: 'Could not reach the server', description: error.message }
    default:
      return { title: 'Request failed', description: error.message }
  }
}
