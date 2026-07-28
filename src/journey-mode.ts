import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import type { Journey, JourneyLeg } from './phone'
import { cleanGlassesText } from './glasses-text'

const INNER_WIDTH = 568
const DISPLAY_WIDTH = 576
const DISPLAY_INSET = 12
const MIN_TOP_GAP = 10
const ROUTE_BAR_WIDTH = 520
export const ALERT_CONTAINER_WIDTH = 400
export const ALERT_CONTAINER_X = (DISPLAY_WIDTH - ALERT_CONTAINER_WIDTH) / 2
const ENDPOINT_GAP = 12
const ENDPOINT_MAX_WIDTH = (
  DISPLAY_WIDTH - (2 * DISPLAY_INSET) - ENDPOINT_GAP
) / 2
const STAGE_ZERO_HINT = 'Swipe: stages   Tap: hide   2x: exit'

export type JourneyStage =
  | {
    type: 'walk'
    leg: JourneyLeg
  }
  | {
    type: 'ride'
    leg: JourneyLeg
  }
  | {
    type: 'arrive'
  }

export interface PositionedLine {
  content: string
  xPosition: number
  width: number
}

export interface JourneyAlertCandidate {
  key: string
  content: string
}

export type StagePageContent =
  | {
    type: 'ride'
    topLeft: PositionedLine
    topCenter: PositionedLine
    topRight: PositionedLine
    bottomDeparture: PositionedLine
    bottomArrival: PositionedLine
    bottomBar: PositionedLine
    bottomCount: PositionedLine
  }
  | {
    type: 'top'
    topLines: PositionedLine[]
    bottomLine?: PositionedLine
  }

export function deriveJourneyStages(journey: Journey): JourneyStage[] {
  const stages: JourneyStage[] = journey.legs.map(leg => (
    isWalkingLeg(leg) ? { type: 'walk', leg } : { type: 'ride', leg }
  ))

  if (journey.legs.at(-1)?.mode?.name !== 'walking') {
    stages.push({ type: 'arrive' })
  }

  return stages
}

export function buildStagePage(
  stage: JourneyStage,
  stageIndex: number,
  stageTotal: number,
  passedStopCount = 0,
  rideHasStarted = false,
): StagePageContent {
  if (stage.type === 'walk') {
    return buildWalkPage(stage.leg, stageIndex, stageTotal)
  }
  if (stage.type === 'arrive') {
    return {
      type: 'top',
      topLines: [
        positionCentered(fitLine('Walk to your destination', INNER_WIDTH)),
      ],
    }
  }

  return buildRidePage(
    stage.leg,
    stageIndex,
    stageTotal,
    passedStopCount,
    rideHasStarted,
  )
}

function buildRidePage(
  leg: JourneyLeg,
  stageIndex: number,
  stageTotal: number,
  passedStopCount: number,
  rideHasStarted: boolean,
): StagePageContent {
  const summary = leg.instruction?.summary
    ?? leg.routeOptions?.[0]?.name
    ?? leg.mode?.name
    ?? 'Journey stage'
  const departure = fitLine(
    leg.departurePoint?.commonName ?? 'Departure',
    ENDPOINT_MAX_WIDTH,
  )
  const arrival = fitLine(
    leg.arrivalPoint?.commonName ?? 'Arrival',
    ENDPOINT_MAX_WIDTH,
  )
  const stopPoints = leg.path?.stopPoints ?? []
  const bar = buildMeasuredBar(
    stopPoints.length,
    passedStopCount,
    rideHasStarted,
  )
  const bottomBar = positionCentered(bar)
  const arrivalLabel = `Arrive ${formatTime(leg.arrivalTime)}`
  const stageLabel = `Stage ${stageIndex + 1} of ${stageTotal}`
  const [topLeft, topCenter, topRight] = positionSpreadTopRow(
    arrivalLabel,
    summary,
    stageLabel,
  )

  return {
    type: 'ride',
    topLeft,
    topCenter,
    topRight,
    bottomDeparture: positionLeftAt(departure, bottomBar.xPosition),
    bottomArrival: positionRightAt(
      arrival,
      bottomBar.xPosition + bottomBar.width,
    ),
    bottomBar,
    bottomCount: positionCentered(
      `${stopPoints.length} ${stopPoints.length === 1 ? 'stop' : 'stops'}`,
    ),
  }
}

function buildWalkPage(
  leg: JourneyLeg,
  stageIndex: number,
  stageTotal: number,
): StagePageContent {
  const summary = leg.instruction?.summary
    ?? `Walk to ${leg.arrivalPoint?.commonName ?? 'your next stop'}`
  const duration = leg.duration ?? 0
  const topLines = [
    fitLine(summary, INNER_WIDTH),
    fitLine(
      `about ${duration} min · Stage ${stageIndex + 1} of ${stageTotal}`,
      INNER_WIDTH,
    ),
  ]
  return {
    type: 'top',
    topLines: topLines.map(positionCentered),
    bottomLine: stageIndex === 0
      ? positionCentered(fitLine(STAGE_ZERO_HINT, INNER_WIDTH))
      : undefined,
  }
}

function isWalkingLeg(leg: JourneyLeg): boolean {
  return leg.mode?.name === 'walking'
}

function buildMeasuredBar(
  stopCount: number,
  passedStopCount: number,
  rideHasStarted: boolean,
): string {
  const glyphWidth = getTextWidth('─')
  const targetGlyphCount = Math.floor(ROUTE_BAR_WIDTH / glyphWidth)
  const maxIntermediateMarkers = Math.max(
    0,
    Math.floor((targetGlyphCount - 3) / 2),
  )
  const intermediateStopCount = Math.max(0, stopCount - 1)
  const displayedStopIndices = selectDisplayedStopIndices(
    intermediateStopCount,
    maxIntermediateMarkers,
  )
  const segmentCount = displayedStopIndices.length + 1
  const connectorsPerSegment = Math.max(
    1,
    Math.floor(
      (targetGlyphCount - 2 - displayedStopIndices.length) / segmentCount,
    ),
  )
  const computedBarWidth = (
    2
    + displayedStopIndices.length
    + (segmentCount * connectorsPerSegment)
  ) * glyphWidth
  let bar = rideHasStarted ? '●' : '○'

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    bar += '─'.repeat(connectorsPerSegment)

    const stopIndex = displayedStopIndices[segmentIndex]
    if (stopIndex !== undefined) {
      bar += passedStopCount >= stopIndex + 1 ? '●' : '○'
    }
  }

  bar += stopCount > 0 && passedStopCount >= stopCount ? '●' : '○'

  if (
    getTextWidth(bar) !== computedBarWidth
    || measureTextWrap(bar, computedBarWidth).lineCount !== 1
  ) {
    throw new Error('Route bar width changed while applying live fill')
  }

  return bar
}

function selectDisplayedStopIndices(
  intermediateStopCount: number,
  maximum: number,
): number[] {
  if (intermediateStopCount <= maximum) {
    return Array.from({ length: intermediateStopCount }, (_, index) => index)
  }

  if (maximum <= 1) {
    return maximum === 1 ? [intermediateStopCount - 1] : []
  }

  return Array.from(
    { length: maximum },
    (_, index) => Math.round(
      (index * (intermediateStopCount - 1)) / (maximum - 1),
    ),
  )
}

function fitLine(text: string, maxWidth: number): string {
  const truncated = pxTruncate(cleanGlassesText(text), maxWidth)
  if (!isSingleLine(truncated, maxWidth)) {
    throw new Error(`Measured text still wraps at ${maxWidth}px`)
  }
  return truncated
}

function isSingleLine(text: string, maxWidth: number): boolean {
  return getTextWidth(text) <= maxWidth
    && measureTextWrap(text, maxWidth).lineCount <= 1
}

function positionCentered(content: string): PositionedLine {
  const width = measuredWidth(content)
  return {
    content,
    xPosition: Math.max(0, Math.floor((DISPLAY_WIDTH - width) / 2)),
    width,
  }
}

export function passedStopsAt(leg: JourneyLeg, atMs: number): number {
  const timeline = legTimeline(leg)
  if (timeline === undefined || timeline.stopCount === 0) {
    return 0
  }
  if (atMs <= timeline.departureMs) {
    return 0
  }
  if (atMs >= timeline.arrivalMs) {
    return timeline.stopCount
  }

  return Math.min(
    timeline.stopCount,
    Math.max(
      0,
      Math.floor(
        ((atMs - timeline.departureMs) * timeline.stopCount)
        / (timeline.arrivalMs - timeline.departureMs),
      ),
    ),
  )
}

export function rideHasStartedAt(leg: JourneyLeg, atMs: number): boolean {
  const timeline = legTimeline(leg)
  return timeline !== undefined && atMs >= timeline.departureMs
}

export function journeyAlertAt(
  journey: Journey,
  atMs: number,
): JourneyAlertCandidate | undefined {
  let nextStopAlert: JourneyAlertCandidate | undefined

  for (let legIndex = 0; legIndex < journey.legs.length; legIndex += 1) {
    const leg = journey.legs[legIndex]!
    if (isWalkingLeg(leg)) {
      continue
    }

    const timeline = legTimeline(leg)
    if (timeline === undefined || timeline.stopCount === 0) {
      continue
    }

    if (
      atMs >= timeline.arrivalMs - 30_000
      && atMs < timeline.arrivalMs
    ) {
      return {
        key: `stop:${legIndex}:${timeline.arrivalMs}`,
        content: 'This is your stop',
      }
    }

    const nextStopTrigger = timeline.stopCount === 1
      ? timeline.departureMs
      : timeline.departureMs
        + (
          (timeline.arrivalMs - timeline.departureMs)
          * (timeline.stopCount - 1)
        ) / timeline.stopCount
    const nextStopEnd = Math.min(nextStopTrigger + 10_000, timeline.arrivalMs)
    if (
      nextStopAlert === undefined
      && atMs >= nextStopTrigger
      && atMs < nextStopEnd
    ) {
      nextStopAlert = {
        key: `next:${legIndex}:${nextStopTrigger}`,
        content: `Next stop: ${leg.arrivalPoint?.commonName ?? 'destination'}`,
      }
    }
  }

  return nextStopAlert
}

export function buildAlertContainerContent(message?: string): string {
  if (message === undefined) {
    return ' '
  }

  const fitted = fitLine(message, ALERT_CONTAINER_WIDTH)
  const availableLeftWidth = Math.max(
    0,
    (ALERT_CONTAINER_WIDTH - getTextWidth(fitted)) / 2,
  )
  let leadingSpaces = Math.floor(availableLeftWidth / getTextWidth(' '))
  let content = `${' '.repeat(leadingSpaces)}${fitted}`

  while (
    leadingSpaces > 0
    && !isSingleLine(content, ALERT_CONTAINER_WIDTH)
  ) {
    leadingSpaces -= 1
    content = `${' '.repeat(leadingSpaces)}${fitted}`
  }

  if (!isSingleLine(content, ALERT_CONTAINER_WIDTH)) {
    throw new Error('Centred alert content exceeds its fixed container')
  }

  return content
}

function positionLeftAt(content: string, xPosition: number): PositionedLine {
  return {
    content,
    xPosition,
    width: measuredWidth(content),
  }
}

function positionRightAt(content: string, rightEdge: number): PositionedLine {
  const width = measuredWidth(content)
  return {
    content,
    xPosition: rightEdge - width,
    width,
  }
}

function measuredWidth(content: string): number {
  return Math.max(1, Math.ceil(getTextWidth(content)))
}

function legTimeline(leg: JourneyLeg): {
  departureMs: number
  arrivalMs: number
  stopCount: number
} | undefined {
  const departureMs = Date.parse(leg.departureTime ?? '')
  const arrivalMs = Date.parse(leg.arrivalTime ?? '')
  if (
    !Number.isFinite(departureMs)
    || !Number.isFinite(arrivalMs)
    || arrivalMs <= departureMs
  ) {
    return undefined
  }

  return {
    departureMs,
    arrivalMs,
    stopCount: leg.path?.stopPoints?.length ?? 0,
  }
}

function positionSpreadTopRow(
  leftContent: string,
  centerContent: string,
  rightContent: string,
): [PositionedLine, PositionedLine, PositionedLine] {
  const cleanedLeft = cleanGlassesText(leftContent)
  const cleanedCenter = cleanGlassesText(centerContent)
  const cleanedRight = cleanGlassesText(rightContent)
  const centerWidth = measuredWidth(cleanedCenter)
  const rightWidth = measuredWidth(cleanedRight)
  const availableWidth = DISPLAY_WIDTH - (2 * DISPLAY_INSET)
  const maxLeftWidth = Math.max(
    1,
    availableWidth - centerWidth - rightWidth - (2 * MIN_TOP_GAP),
  )
  const fittedLeft = fitLine(cleanedLeft, maxLeftWidth)
  const leftWidth = measuredWidth(fittedLeft)
  const totalGap = Math.max(
    0,
    availableWidth - leftWidth - centerWidth - rightWidth,
  )
  const firstGap = Math.floor(totalGap / 2)

  return [
    {
      content: fittedLeft,
      xPosition: DISPLAY_INSET,
      width: leftWidth,
    },
    {
      content: cleanedCenter,
      xPosition: DISPLAY_INSET + leftWidth + firstGap,
      width: centerWidth,
    },
    {
      content: cleanedRight,
      xPosition: DISPLAY_WIDTH - DISPLAY_INSET - rightWidth,
      width: rightWidth,
    },
  ]
}

function formatTime(value: string | undefined): string {
  if (value === undefined) {
    return '--:--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--:--'
  }

  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':')
}
