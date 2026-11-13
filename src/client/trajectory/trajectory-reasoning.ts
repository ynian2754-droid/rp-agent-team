import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Some providers return thinking tags as text instead of native reasoning blocks.
 * Normalize only the observation copy; Session logs and published RP stay untouched.
 * An unfinished tag retains the live reasoning accumulated so far.
 */
export function assistantReasoningBlocks(blocks: readonly AssistantBlock[]): AssistantBlock[] {
  return blocks.flatMap((block): AssistantBlock[] => {
    if (block.kind !== 'text') return [block]
    const parts: AssistantBlock[] = []
    const pattern = /<(think(?:ing)?|reasoning)(?:\s[^>]*)?>([\s\S]*?)(?:<\/\1\s*>|$)/gi
    let offset = 0
    for (const match of block.text.matchAll(pattern)) {
      if (match.index > offset) parts.push({ kind: 'text', text: block.text.slice(offset, match.index) })
      if (match[2]) parts.push({ kind: 'reasoning', text: match[2] })
      offset = match.index + match[0].length
    }
    if (offset === 0) return [block]
    if (offset < block.text.length) parts.push({ kind: 'text', text: block.text.slice(offset) })
    return parts
  })
}
