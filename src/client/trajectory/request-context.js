/** Convert actual native request messages to the inspector's presentation DTO.
 * Older product records already contain display titles; keep those intact.
 * Never reconstruct a request from current configuration.
 */
export function normalizeRequestContext(context) {
  if (!Array.isArray(context)) return undefined
  return context.map((item, index) => {
    const native = typeof item.source === 'object' && item.source !== null
    const source = native ? item.source : null
    const sourceKind = source?.kind || ''
    const kind = item.kind || (item.role === 'system' ? 'system'
      : sourceKind === 'tool' ? 'tool' : item.role === 'assistant' ? 'assistant'
      : sourceKind === 'user' ? 'user' : 'context')
    return {
      ...item,
      order: native ? index + 1 : item.order,
      kind,
      title: item.title ?? ({system:'系统提示词', user:'用户输入', assistant:'助手消息', tool:'工具结果'}[kind] || '上下文'),
      source: native ? [sourceKind, source.provider, source.model, source.callId].filter(Boolean).join(' · ') : item.source,
      anchor: item.anchor ?? '',
      content: native ? readableContent(item.content) : item.content,
    }
  })
}

function readableContent(content) {
  let blocks
  try { blocks = JSON.parse(content) } catch { return content }
  if (!Array.isArray(blocks)) return content
  return blocks.map(block => block.type === 'text' ? block.text : JSON.stringify(block, null, 2)).join('\n\n')
}
