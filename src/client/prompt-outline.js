const HEADING = /^(?:#{1,6}\s+\S.*|【[^】\n]{1,30}】.*|[一二三四五六七八九十]{1,3}、\S.*)$/

/** Section headings an author already wrote into a prompt, with the offset each one starts at. */
export function promptOutline(text, limit = 14) {
  const outline = []
  let offset = 0
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length <= 60 && HEADING.test(trimmed)) outline.push({ offset, label: trimmed.replace(/^#{1,6}\s+/, '').replace(/[：:]$/, '').slice(0, 18) })
    offset += line.length + 1
  }
  return outline.slice(0, limit)
}

/** Ids of the `{{param:id}}` tokens a prompt uses, in first-use order. */
export function promptParameters(text) {
  return [...new Set([...String(text || '').matchAll(/\{\{param:([^}\s]+)\}\}/g)].map(match => match[1]))]
}
