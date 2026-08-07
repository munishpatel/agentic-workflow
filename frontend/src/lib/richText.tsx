import type { ReactNode } from 'react'

/**
 * A deliberately tiny renderer for model output: paragraphs, headings, bullet
 * lists, `**bold**`, `` `code` `` and `[links](url)`. Not a markdown
 * implementation — it exists so the final response reads as prose instead of
 * showing its own punctuation, without pulling in a parser or ever touching
 * `dangerouslySetInnerHTML`.
 *
 * Links and headings were added after watching a real research run: the model
 * cites sources as markdown links and structures long answers with `##`, and
 * both were showing as raw syntax.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/

/** Only http(s) is followed — never `javascript:` or a data URI from a model. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null
}

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
    const link = LINK.exec(part)
    if (link) {
      const [, label, url] = link
      const href = safeHref(url ?? '')
      if (!href) return [<span key={key}>{label}</span>]
      return [
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground underline underline-offset-2 hover:no-underline"
        >
          {label}
        </a>,
      ]
    }
    return [<span key={key}>{part}</span>]
  })
}

const HEADING = /^(#{1,4})\s+(.*)$/

const BULLET = /^\s*[-*]\s+/
const NUMBERED = /^\s*\d+[.)]\s+/

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/)

  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n')

        const heading = lines.length === 1 ? HEADING.exec(lines[0] ?? '') : null
        if (heading) {
          const level = (heading[1] ?? '#').length
          return (
            <p
              key={blockIndex}
              className={`mt-4 mb-1 font-semibold first:mt-0 ${
                level <= 2 ? 'text-[1.05em]' : ''
              }`}
            >
              {renderInline(heading[2] ?? '', `${blockIndex}-h`)}
            </p>
          )
        }

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
