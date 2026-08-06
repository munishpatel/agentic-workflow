import { useEffect } from 'react'
import { useEditorStore } from '@/store/editorStore'

/** True when the keystroke belongs to whatever the user is typing in. */
function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

interface Shortcuts {
  onSave: () => void
}

/**
 * The editor shortcuts everyone tries: ⌘S saves, ⌘Z / ⇧⌘Z step history, and
 * Delete removes the selected node. All of them stand down while a field has
 * focus, so undo inside a textarea stays the browser's undo.
 */
export function useEditorShortcuts({ onSave }: Shortcuts) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey
      const editing = isEditingText(event.target)

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (useEditorStore.getState().isDirty) onSave()
        return
      }

      if (editing) return

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) useEditorStore.getState().redo()
        else useEditorStore.getState().undo()
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const { selectedNodeId, removeNode } = useEditorStore.getState()
        // React Flow handles this itself while the canvas has focus; this covers
        // the outline view and a selection made from the validation banner.
        if (selectedNodeId && !(event.target as HTMLElement)?.closest?.('.react-flow')) {
          event.preventDefault()
          removeNode(selectedNodeId)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSave])
}
