import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import type { Journey, JourneyLeg } from './phone'

const INNER_WIDTH = 568
const NAME_WIDTH = 240
const FOOTER = 'Swipe: stages   2x tap: exit'

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

export interface StagePageContent {
  header: string
  body: string
  footer: string
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
    return buildWalkPage(stage.leg)
  }
  if (stage.type === 'arrive') {
    return {
      header: '',
      body: fitLine('Walk to your destination', INNER_WIDTH),
      footer: FOOTER,
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
  const duration = leg.duration ?? 0
  const stageLine = `Stage ${stageIndex + 1} of ${stageTotal} · ${duration} min`
  const header = [
    fitLine(summary, INNER_WIDTH),
    fitLine(stageLine, INNER_WIDTH),
  ].join('\n')

  const departure = fitLine(leg.departurePoint?.commonName ?? 'Departure', NAME_WIDTH)
  const arrival = fitLine(leg.arrivalPoint?.commonName ?? 'Arrival', NAME_WIDTH)
  const names = fitNamesLine(departure, arrival)
  const stopPoints = leg.path?.stopPoints ?? []
  const intermediateStopCount = Math.max(0, stopPoints.length - 1)
  const bar = buildMeasuredBar(intermediateStopCount)
  const detail = fitLine(
    `${stopPoints.length} stops · arrive ${formatTime(leg.arrivalTime)}`,
    INNER_WIDTH,
  )

  return {
    header,
    body: [names, bar, detail].join('\n'),
    footer: FOOTER,
  }
}

function buildWalkPage(leg: JourneyLeg): StagePageContent {
  const summary = leg.instruction?.summary
    ?? `Walk to ${leg.arrivalPoint?.commonName ?? 'your next stop'}`
  const duration = leg.duration ?? 0

  return {
    header: fitLine('Walk', INNER_WIDTH),
    body: [
      fitLine(summary, INNER_WIDTH),
      fitLine(`about ${duration} min`, INNER_WIDTH),
    ].join('\n'),
    footer: FOOTER,
  }
}

function isWalkingLeg(leg: JourneyLeg): boolean {
  return leg.mode?.name === 'walking'
}

function fitNamesLine(departure: string, arrival: string): string {
  const line = `${departure} → ${arrival}`
  if (isSingleLine(line, INNER_WIDTH)) {
    return line
  }

  const separatorWidth = getTextWidth(' → ')
  const departureWidth = getTextWidth(departure)
  const remainingWidth = Math.max(0, INNER_WIDTH - departureWidth - separatorWidth)
  return `${departure} → ${fitLine(arrival, remainingWidth)}`
}

function buildMeasuredBar(intermediateStopCount: number): string {
  let markerStride = 1
  let bar = renderBar(intermediateStopCount, markerStride)

  while (!isSingleLine(bar, INNER_WIDTH) && markerStride <= intermediateStopCount) {
    markerStride *= 2
    bar = renderBar(intermediateStopCount, markerStride)
  }

  if (!isSingleLine(bar, INNER_WIDTH)) {
    bar = renderBar(intermediateStopCount, Number.POSITIVE_INFINITY)
  }

  if (!isSingleLine(bar, INNER_WIDTH)) {
    const maxIntermediateMarkers = Math.max(
      0,
      Math.floor(((INNER_WIDTH / getTextWidth('─')) - 3) / 2),
    )
    bar = renderBar(Math.min(intermediateStopCount, maxIntermediateMarkers), 1)
  }

  if (!isSingleLine(bar, INNER_WIDTH)) {
    throw new Error(`Compressed route bar exceeds ${INNER_WIDTH}px`)
  }

  return bar
}

function renderBar(intermediateStopCount: number, markerStride: number): string {
  let bar = '●'

  for (let index = 0; index < intermediateStopCount; index += 1) {
    const showMarker = Number.isFinite(markerStride) && index % markerStride === 0
    bar += showMarker ? '─○' : '─'
  }

  return `${bar}─●`
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
