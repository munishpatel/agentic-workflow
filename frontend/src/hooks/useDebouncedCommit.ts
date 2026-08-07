import { useEffect, useRef, useState } from 'react'

/**
 * Keeps a text input responsive while writing through to the store on a pause.
 *
 * Committing on every keystroke would fill undo history with single characters;
 * committing only on blur loses the last edit when the user navigates away. A
 * debounce is the honest middle, and the local value keeps the caret steady.
 */
export function useDebouncedCommit<T>(
  value: T,
  commit: (next: T) => void,
  delay = 300,
): [T, (next: T) => void] {
  const [local, setLocal] = useState(value)
  const committed = useRef(value)
  const commitRef = useRef(commit)
  commitRef.current = commit

  // An external change (undo, hydrate, switching nodes) wins over local state.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value
      setLocal(value)
    }
  }, [value])

  useEffect(() => {
    if (local === committed.current) return
    const timer = setTimeout(() => {
      committed.current = local
      commitRef.current(local)
    }, delay)
    return () => clearTimeout(timer)
  }, [local, delay])

  return [local, setLocal]
}
