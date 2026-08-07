import { Bot, Box, GitBranch, LogIn, LogOut, Wrench, type LucideIcon } from 'lucide-react'
import type { PortType } from '@/types/api'

/**
 * How each node kind looks, in one place, so the palette, the canvas and the
 * run timeline agree. Kinds come from the server, so an unknown kind must still
 * render — hence the fallback rather than an exhaustive record.
 *
 * The class strings are literal on purpose: Tailwind cannot see a class name
 * that is assembled at runtime.
 */
export interface KindVisual {
  icon: LucideIcon
  /** Icon and label colour. */
  text: string
  /** Tinted chip background. */
  bg: string
  /** Left accent on canvas nodes. */
  border: string
}

const FALLBACK: KindVisual = {
  icon: Box,
  text: 'text-muted-foreground',
  bg: 'bg-muted',
  border: 'border-l-muted-foreground',
}

const VISUALS: Record<string, KindVisual> = {
  input: {
    icon: LogIn,
    text: 'text-kind-input',
    bg: 'bg-kind-input/10',
    border: 'border-l-kind-input',
  },
  agent: {
    icon: Bot,
    text: 'text-kind-agent',
    bg: 'bg-kind-agent/10',
    border: 'border-l-kind-agent',
  },
  tool: {
    icon: Wrench,
    text: 'text-kind-tool',
    bg: 'bg-kind-tool/10',
    border: 'border-l-kind-tool',
  },
  router: {
    icon: GitBranch,
    text: 'text-kind-router',
    bg: 'bg-kind-router/10',
    border: 'border-l-kind-router',
  },
  output: {
    icon: LogOut,
    text: 'text-kind-output',
    bg: 'bg-kind-output/10',
    border: 'border-l-kind-output',
  },
}

export function nodeKindVisual(kind: string): KindVisual {
  return VISUALS[kind] ?? FALLBACK
}

const PORT_COLOURS: Record<string, string> = {
  text: 'text-port-text',
  json: 'text-port-json',
  number: 'text-port-number',
  boolean: 'text-port-boolean',
  any: 'text-port-any',
}

const PORT_DOTS: Record<string, string> = {
  text: 'bg-port-text',
  json: 'bg-port-json',
  number: 'bg-port-number',
  boolean: 'bg-port-boolean',
  any: 'bg-port-any',
}

export function portTypeColour(type: PortType | string): string {
  return PORT_COLOURS[type] ?? 'text-muted-foreground'
}

export function portTypeDot(type: PortType | string): string {
  return PORT_DOTS[type] ?? 'bg-muted-foreground'
}

/**
 * The same accents as CSS variable references, for consumers that take a colour
 * string rather than a class name — React Flow's edge strokes and MiniMap.
 */
const KIND_VARS: Record<string, string> = {
  input: 'var(--color-kind-input)',
  agent: 'var(--color-kind-agent)',
  tool: 'var(--color-kind-tool)',
  router: 'var(--color-kind-router)',
  output: 'var(--color-kind-output)',
}

const PORT_VARS: Record<string, string> = {
  text: 'var(--color-port-text)',
  json: 'var(--color-port-json)',
  number: 'var(--color-port-number)',
  boolean: 'var(--color-port-boolean)',
  any: 'var(--color-port-any)',
}

export function nodeKindColorVar(kind: string): string {
  return KIND_VARS[kind] ?? 'var(--color-muted-foreground)'
}

export function portTypeColorVar(type: PortType | string): string {
  return PORT_VARS[type] ?? 'var(--color-muted-foreground)'
}
