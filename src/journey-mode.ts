import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import type { Journey, JourneyLeg } from './phone'

const INNER_WIDTH = 568
const DISPLAY_WIDTH = 576
const DISPLAY_INSET = 12
const MIN_TOP_GAP = 10
const ROUTE_BAR_WIDTH = 520
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

  return buildRidePage(stage.leg, stageIndex, stageTotal)
}

function buildRidePage(
  leg: JourneyLeg,
  stageIndex: number,
  stageTotal: number,
): StagePageContent {
  const summary = leg.instruction?.summary
    ?? leg.routeOptions?.[0]?.name
    ?? leg.mode?.name
    ?? 'Journey stage'
  const departure = fitLine(
    trimUndergroundStation(leg.departurePoint?.commonName ?? 'Departure'),
    ENDPOINT_MAX_WIDTH,
  )
  const arrival = fitLine(
    trimUndergroundStation(leg.arrivalPoint?.commonName ?? 'Arrival'),
    ENDPOINT_MAX_WIDTH,
  )
  const stopPoints = leg.path?.stopPoints ?? []
  const intermediateStopCount = Math.max(0, stopPoints.length - 1)
  const bar = buildMeasuredBar(intermediateStopCount, ROUTE_BAR_WIDTH)
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
  intermediateStopCount: number,
  maxWidth = INNER_WIDTH,
): string {
  let markerStride = 1
  let displayedIntermediateCount = intermediateStopCount
  let bar = renderBar(intermediateStopCount, markerStride)

  while (!isSingleLine(bar, maxWidth) && markerStride <= intermediateStopCount) {
    markerStride *= 2
    bar = renderBar(intermediateStopCount, markerStride)
  }

  if (!isSingleLine(bar, maxWidth)) {
    bar = renderBar(intermediateStopCount, Number.POSITIVE_INFINITY)
  }

  if (!isSingleLine(bar, maxWidth)) {
    const maxIntermediateMarkers = Math.max(
      0,
      Math.floor(((maxWidth / getTextWidth('─')) - 3) / 2),
    )
    displayedIntermediateCount = Math.min(
      intermediateStopCount,
      maxIntermediateMarkers,
    )
    markerStride = 1
    bar = renderBar(displayedIntermediateCount, markerStride)
  }

  if (!isSingleLine(bar, maxWidth)) {
    throw new Error(`Compressed route bar exceeds ${maxWidth}px`)
  }

  const extraConnectors = Math.max(
    0,
    Math.floor((maxWidth - getTextWidth(bar)) / getTextWidth('─')),
  )
  const expanded = renderBar(
    displayedIntermediateCount,
    markerStride,
    extraConnectors,
  )

  if (!isSingleLine(expanded, maxWidth)) {
    throw new Error(`Expanded route bar exceeds ${maxWidth}px`)
  }

  return expanded
}

function renderBar(
  intermediateStopCount: number,
  markerStride: number,
  extraConnectors = 0,
): string {
  let bar = '●'
  const segmentCount = intermediateStopCount + 1

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const previousExtras = Math.floor(
      (extraConnectors * segmentIndex) / segmentCount,
    )
    const currentExtras = Math.floor(
      (extraConnectors * (segmentIndex + 1)) / segmentCount,
    )
    bar += '─'.repeat(1 + currentExtras - previousExtras)

    if (segmentIndex < intermediateStopCount) {
      const showMarker = Number.isFinite(markerStride)
        && segmentIndex % markerStride === 0
      if (showMarker) {
        bar += '○'
      }
    }
  }

  return `${bar}●`
}

function fitLine(text: string, maxWidth: number): string {
  const truncated = pxTruncate(text, maxWidth)
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

function trimUndergroundStation(name: string): string {
  const trimmed = name.replace(/\s+Underground Station$/i, '').trim()
  return trimmed.length > 0 ? trimmed : name
}

function positionSpreadTopRow(
  leftContent: string,
  centerContent: string,
  rightContent: string,
): [PositionedLine, PositionedLine, PositionedLine] {
  const centerWidth = measuredWidth(centerContent)
  const rightWidth = measuredWidth(rightContent)
  const availableWidth = DISPLAY_WIDTH - (2 * DISPLAY_INSET)
  const maxLeftWidth = Math.max(
    1,
    availableWidth - centerWidth - rightWidth - (2 * MIN_TOP_GAP),
  )
  const fittedLeft = fitLine(leftContent, maxLeftWidth)
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
      content: centerContent,
      xPosition: DISPLAY_INSET + leftWidth + firstGap,
      width: centerWidth,
    },
    {
      content: rightContent,
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
