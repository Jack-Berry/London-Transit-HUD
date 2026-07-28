const UNDERGROUND_STATION = /\s*\bUnderground Station\b\s*/gi

export function cleanGlassesText(text: string): string {
  const cleanedLines = text.split('\n').map(line => (
    line
      .replace(UNDERGROUND_STATION, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .trim()
  ))
  const cleaned = cleanedLines.filter(line => line.length > 0).join('\n')
  return cleaned.length > 0 ? cleaned : ' '
}
