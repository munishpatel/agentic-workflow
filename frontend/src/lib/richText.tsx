import type { ReactNode } from 'react'

/**
 * A deliberately tiny renderer for model output: paragraphs, bullet lists,
 * `**bold**` and `` `code` ``. Not a markdown implementation — it exists so the
 * final response reads as prose instead of showing its own asterisks, without
 * pulling in a parser or ever touching `dangerouslySetInnerHTML`.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).flatMap((part, index) => {
    if (!part) return []
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**')) {
      return [
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>,
      ]
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return [
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>,
      ]
    }
    return [<span key={key}>{part}</span>]
  })
}

const BULLET = /^\s*[-*]\s+/
const NUMBERED = /^\s*\d+[.)]\s+/

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/)

  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n')
        const isList = lines.every((line) => BULLET.test(line) || NUMBERED.test(line))

        if (isList) {
          const numbered = NUMBERED.test(lines[0] ?? '')
          const ListTag = numbered ? 'ol' : 'ul'
          return (
            <ListTag
              key={blockIndex}
              className={`my-2 ml-5 space-y-1 first:mt-0 last:mb-0 ${
                numbered ? 'list-decimal' : 'list-disc'
              }`}
            >
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>
                  {renderInline(
                    line.replace(BULLET, '').replace(NUMBERED, ''),
                    `${blockIndex}-${lineIndex}`,
                  )}
                </li>
              ))}
            </ListTag>
          )
        }

        return (
          <p key={blockIndex} className="my-2 first:mt-0 last:mb-0">
            {lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line, `${blockIndex}-${lineIndex}`)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}
