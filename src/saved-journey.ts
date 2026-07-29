import type { Journey } from './phone'

export const SAVED_JOURNEY_KEY = 'savedJourney'
export const SAVED_JOURNEY_TTL_MS = 24 * 60 * 60 * 1_000

export interface SavedJourneyEndpoint {
  endpoint: string
  label: string
}

export interface SavedJourneyTiming {
  mode: 'now' | 'departing' | 'arriving'
  date?: string
  time?: string
}

export interface SavedJourneyRecord {
  version: 1
  savedAt: number
  from: SavedJourneyEndpoint
  to: SavedJourneyEndpoint
  timing: SavedJourneyTiming
  signature: string
  journey: Journey
}

export interface DecodedSavedJourney {
  record?: SavedJourneyRecord
  expired: boolean
}

export function routeSignature(journey: Journey): string {
  return JSON.stringify(journey.legs.map(leg => [
    leg.mode?.name ?? '',
    leg.routeOptions?.[0]?.name ?? '',
  ]))
}

export function timingFromQuery(params: URLSearchParams): SavedJourneyTiming {
  const date = params.get('date')
  const time = params.get('time')
  const timeIs = params.get('timeIs')?.toLowerCase()
  if (date === null || time === null) {
    return { mode: 'now' }
  }

  return {
    mode: timeIs === 'arriving' ? 'arriving' : 'departing',
    date,
    time,
  }
}

export function queryForSavedTiming(
  timing: SavedJourneyTiming,
  atMs: number,
): URLSearchParams {
  const params = new URLSearchParams()
  if (
    timing.mode === 'now'
    || timing.date === undefined
    || timing.time === undefined
    || savedTimingMoment(timing) <= atMs
  ) {
    return params
  }

  params.set('date', timing.date)
  params.set('time', timing.time)
  params.set('timeIs', timing.mode === 'arriving' ? 'Arriving' : 'Departing')
  return params
}

export function decodeSavedJourney(
  value: string,
  atMs: number,
): DecodedSavedJourney {
  if (value.trim() === '') {
    return { expired: false }
  }

  try {
    const candidate: unknown = JSON.parse(value)
    if (!isSavedJourneyRecord(candidate)) {
      return { expired: false }
    }
    if (atMs - candidate.savedAt >= SAVED_JOURNEY_TTL_MS) {
      return { expired: true }
    }
    return {
      record: candidate,
      expired: false,
    }
  } catch {
    return { expired: false }
  }
}

function savedTimingMoment(timing: SavedJourneyTiming): number {
  if (
    timing.date === undefined
    || timing.time === undefined
    || !/^\d{8}$/.test(timing.date)
    || !/^\d{4}$/.test(timing.time)
  ) {
    return Number.NEGATIVE_INFINITY
  }

  const year = Number(timing.date.slice(0, 4))
  const month = Number(timing.date.slice(4, 6))
  const day = Number(timing.date.slice(6, 8))
  const hours = Number(timing.time.slice(0, 2))
  const minutes = Number(timing.time.slice(2, 4))
  const date = new Date(year, month - 1, day, hours, minutes)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
  ) {
    return Number.NEGATIVE_INFINITY
  }
  return date.getTime()
}

function isSavedJourneyRecord(value: unknown): value is SavedJourneyRecord {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<SavedJourneyRecord>
  return candidate.version === 1
    && typeof candidate.savedAt === 'number'
    && Number.isFinite(candidate.savedAt)
    && candidate.savedAt >= 0
    && isEndpoint(candidate.from)
    && isEndpoint(candidate.to)
    && isTiming(candidate.timing)
    && typeof candidate.signature === 'string'
    && candidate.signature !== ''
    && isJourney(candidate.journey)
}

function isEndpoint(value: unknown): value is SavedJourneyEndpoint {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<SavedJourneyEndpoint>
  return typeof candidate.endpoint === 'string'
    && candidate.endpoint !== ''
    && typeof candidate.label === 'string'
    && candidate.label !== ''
}

function isTiming(value: unknown): value is SavedJourneyTiming {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<SavedJourneyTiming>
  return (
    candidate.mode === 'now'
    || candidate.mode === 'departing'
    || candidate.mode === 'arriving'
  )
    && (
      candidate.date === undefined
      || typeof candidate.date === 'string'
    )
    && (
      candidate.time === undefined
      || typeof candidate.time === 'string'
    )
}

function isJourney(value: unknown): value is Journey {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<Journey>
  return typeof candidate.duration === 'number'
    && Number.isFinite(candidate.duration)
    && typeof candidate.startDateTime === 'string'
    && typeof candidate.arrivalDateTime === 'string'
    && Array.isArray(candidate.legs)
}
