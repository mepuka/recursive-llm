const FINAL_LITERAL_RE = /FINAL\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/m
const CODE_BLOCK_RE = /```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/m

export const extractFinal = (response: string): string | null => {
  const match = FINAL_LITERAL_RE.exec(response)
  if (!match) {
    return null
  }
  return match[2] ?? null
}

export const extractCodeBlock = (response: string): string | null => {
  const match = CODE_BLOCK_RE.exec(response)
  if (!match) {
    return null
  }
  const block = match[1]
  return block === undefined ? null : block.trim()
}
