import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Shorten a string for display, appending an ellipsis when it was cut. */
export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value
  return `${value.slice(0, max).trimEnd()}…`
}

/** Human-readable duration: 840 → "840ms", 1832 → "1.8s", 92000 → "1m 32s". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** "max_tool_iterations" → "Max tool iterations". Fallback label for schema fields. */
export function humanise(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (!words) return key
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

/** Compact token counts: 1234 → "1.2k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

/** Relative time for list rows: "just now", "3h ago", "12 Mar". */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Pretty-print an unknown value for a <pre> block without throwing on cycles. */
export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** URL-safe, collision-resistant id. Used for client-generated node and edge ids. */
export function createId(prefix = ''): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const body = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('')
  return prefix ? `${prefix}_${body}` : body
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}
