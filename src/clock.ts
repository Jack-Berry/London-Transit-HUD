let clockOffsetMs = 0

export function now(): number {
  return Date.now() + clockOffsetMs
}

export function setClockOffsetSeconds(seconds: number): void {
  clockOffsetMs = seconds * 1_000
}
