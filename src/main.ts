import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import {
  initializePhoneUi,
  type Journey,
  type PhoneUiController,
} from './phone'
import {
  ALERT_CONTAINER_WIDTH,
  ALERT_CONTAINER_X,
  buildAlertContainerContent,
  buildStagePage,
  deriveJourneyStages,
  journeyAlertAt,
  passedStopsAt,
  rideHasStartedAt,
  type StagePageContent,
} from './journey-mode'
import { now, setClockOffsetSeconds } from './clock'
import { cleanGlassesText } from './glasses-text'
import './styles.css'

declare global {
  interface Window {
    __getStateSnapshot?: () => string
    __restoreState?: (snapshot: unknown) => void
  }
}

export const API_BASE = 'https://transit.berrydev.co.uk/tfl'

const STATUS_PATH = '/Line/Mode/tube,elizabeth-line,dlr,overground/Status'
const REFRESH_INTERVAL_MS = 60_000
const BRIDGE_TIMEOUT_MS = 5_000
const HIDDEN_NOTICE_MS = 5_000
const JOURNEY_TICK_MS = 1_000
const MAX_BOARD_CHARACTERS = 475
const LINE_NAME_WIDTH = 13

interface TflLineStatus {
  name?: unknown
  lineStatuses?: Array<{
    statusSeverityDescription?: unknown
  }>
}

interface JourneyState {
  active: boolean
  journey: Journey | null
  stageIndex: number
  hudHidden: boolean
}

class BridgeTimeoutError extends Error {}

let journeyState: JourneyState = {
  active: false,
  journey: null,
  stageIndex: 0,
  hudHidden: false,
}
let journeyStateVersion = 0
let journeyRenderRequest: (() => void) | undefined
let journeyEndRequest: (() => void) | undefined
let hudTimerCancelRequest: (() => void) | undefined
let journeyLiveResetRequest: (() => void) | undefined
let phoneUiController: PhoneUiController | undefined

function restoreJourneyState(saved: unknown): void {
  if (saved === null || typeof saved !== 'object') {
    return
  }

  const s = saved as Partial<JourneyState>
  journeyState = {
    active: s.active ?? journeyState.active,
    journey: s.journey ?? journeyState.journey,
    stageIndex: s.stageIndex ?? journeyState.stageIndex,
    hudHidden: s.hudHidden ?? journeyState.hudHidden,
  }
  journeyStateVersion += 1
  hudTimerCancelRequest?.()
  journeyLiveResetRequest?.()

  if (journeyState.active) {
    journeyRenderRequest?.()
  }
  if (journeyState.active && journeyState.journey !== null) {
    phoneUiController?.showActiveJourney(journeyState.journey)
  } else {
    phoneUiController?.resetPlanner()
  }
}

window.__getStateSnapshot = () => JSON.stringify({
  journeyMode: {
    ...journeyState,
    hudHidden: journeyState.hudHidden,
  },
})

window.__restoreState = snapshot => {
  try {
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
    const saved = (
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['journeyMode']
        : undefined
    )
    if (saved !== undefined) {
      restoreJourneyState(saved)
    }
  } catch {
    // A malformed host snapshot must not replace the current live state.
  }
}

if (import.meta.env.DEV) {
  configureDevClock()
}
phoneUiController = initializePhoneUi(
  API_BASE,
  enterJourneyMode,
  endJourneyMode,
)
if (journeyState.active && journeyState.journey !== null) {
  phoneUiController.showActiveJourney(journeyState.journey)
}
const devJourneyLoad = import.meta.env.DEV ? loadDevJourney() : Promise.resolve()
void initializeApplication().catch(() => {
  console.info('Glasses bridge unavailable')
})

async function initializeApplication(): Promise<void> {
  await devJourneyLoad
  await initializeGlasses()
}

function enterJourneyMode(journey: Journey): void {
  journeyState = {
    active: true,
    journey,
    stageIndex: 0,
    hudHidden: false,
  }
  journeyStateVersion += 1
  journeyLiveResetRequest?.()
  console.log('Journey handoff')
  phoneUiController?.showActiveJourney(journey)
  journeyRenderRequest?.()
}

function endJourneyMode(): void {
  journeyState = {
    active: false,
    journey: null,
    stageIndex: 0,
    hudHidden: false,
  }
  journeyStateVersion += 1
  hudTimerCancelRequest?.()
  journeyLiveResetRequest?.()
  console.log('Journey ended')
  journeyEndRequest?.()
}

function configureDevClock(): void {
  const value = new URLSearchParams(window.location.search).get('dev-clock')
  if (value === null) {
    return
  }

  const seconds = Number(value)
  if (!Number.isFinite(seconds)) {
    console.error('Invalid dev-clock value')
    return
  }

  setClockOffsetSeconds(seconds)
  console.log(`Dev clock offset set to ${seconds} seconds`)
}

async function loadDevJourney(): Promise<void> {
  const value = new URLSearchParams(window.location.search).get('dev-journey')
  if (value === null) {
    return
  }

  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    console.error('Invalid dev-journey value')
    return
  }

  const from = value.slice(0, separator)
  const to = value.slice(separator + 1)

  try {
    const response = await fetch(
      `${API_BASE}/Journey/JourneyResults/${encodeURIComponent(from)}/to/${
        encodeURIComponent(to)
      }`,
    )
    if (!response.ok) {
      throw new Error(`Dev journey failed with HTTP ${response.status}`)
    }

    const data = await response.json() as { journeys?: Journey[] }
    const journey = data.journeys?.[0]
    if (journey === undefined || !Array.isArray(journey.legs)) {
      throw new Error('Dev journey response contained no journeys')
    }

    enterJourneyMode(journey)
    console.log('Dev journey loaded')
  } catch (error) {
    console.error('Unable to load dev journey:', error)
  }
}

function currentStagePage(atMs = now()): StagePageContent | undefined {
  if (!journeyState.active || journeyState.journey === null) {
    return undefined
  }

  const stages = deriveJourneyStages(journeyState.journey)
  if (stages.length === 0) {
    return undefined
  }

  const stageIndex = Math.min(Math.max(journeyState.stageIndex, 0), stages.length - 1)
  if (stageIndex !== journeyState.stageIndex) {
    journeyState = { ...journeyState, stageIndex }
  }

  const stage = stages[stageIndex]!
  const passedStopCount = stage.type === 'ride'
    ? passedStopsAt(stage.leg, atMs)
    : 0
  const rideHasStarted = stage.type === 'ride'
    ? rideHasStartedAt(stage.leg, atMs)
    : false
  return buildStagePage(
    stage,
    stageIndex,
    stages.length,
    passedStopCount,
    rideHasStarted,
  )
}

function createStatusContainers(): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 252,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: 1,
      containerName: 'status',
      content: 'Loading line status...',
      isEventCapture: 1,
    }),
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 252,
      width: 576,
      height: 36,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: 2,
      containerName: 'footer',
      content: 'Swipe: scroll   2x tap: exit',
      isEventCapture: 0,
    }),
  ]
}

function createAlertContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: ALERT_CONTAINER_X,
    yPosition: 166,
    width: ALERT_CONTAINER_WIDTH,
    height: 27,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 0,
    containerID: 8,
    containerName: 'alert',
    content,
    isEventCapture: 0,
  })
}

function createStageContainers(
  page: StagePageContent,
  alertContent: string,
): TextContainerProperty[] {
  if (page.type === 'ride') {
    return [
      new TextContainerProperty({
        xPosition: page.topLeft.xPosition,
        yPosition: 0,
        width: page.topLeft.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 1,
        containerName: 'route',
        content: page.topLeft.content,
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: page.topCenter.xPosition,
        yPosition: 0,
        width: page.topCenter.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 2,
        containerName: 'arrival',
        content: page.topCenter.content,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: page.topRight.xPosition,
        yPosition: 0,
        width: page.topRight.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 3,
        containerName: 'stage-no',
        content: page.topRight.content,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: page.bottomDeparture.xPosition,
        yPosition: 207,
        width: page.bottomDeparture.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 4,
        containerName: 'depart',
        content: page.bottomDeparture.content,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: page.bottomArrival.xPosition,
        yPosition: 207,
        width: page.bottomArrival.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 5,
        containerName: 'destination',
        content: page.bottomArrival.content,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: page.bottomBar.xPosition,
        yPosition: 234,
        width: page.bottomBar.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 6,
        containerName: 'bar',
        content: page.bottomBar.content,
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: page.bottomCount.xPosition,
        yPosition: 261,
        width: page.bottomCount.width,
        height: 27,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 7,
        containerName: 'stop-count',
        content: page.bottomCount.content,
        isEventCapture: 0,
      }),
      createAlertContainer(alertContent),
    ]
  }

  const containers = page.topLines.map((line, index) => (
    new TextContainerProperty({
      xPosition: line.xPosition,
      yPosition: index * 27,
      width: line.width,
      height: 27,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 0,
      containerID: index + 1,
      containerName: `top-${index + 1}`,
      content: line.content,
      isEventCapture: index === 0 ? 1 : 0,
    })
  ))

  if (page.bottomLine !== undefined) {
    containers.push(new TextContainerProperty({
      xPosition: page.bottomLine.xPosition,
      yPosition: 261,
      width: page.bottomLine.width,
      height: 27,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 0,
      containerID: containers.length + 1,
      containerName: 'controls',
      content: page.bottomLine.content,
      isEventCapture: 0,
    }))
  }

  containers.push(createAlertContainer(alertContent))
  return containers
}

function createHiddenContainers(alertContent: string): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 0,
      containerID: 1,
      containerName: 'hidden',
      content: 'HUD hidden · tap to show',
      isEventCapture: 1,
    }),
    createAlertContainer(alertContent),
  ]
}

async function initializeGlasses(): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  const dismissedAlertKeys = new Set<string>()

  function currentAlertContainerContent(atMs = now()): string {
    if (!journeyState.active || journeyState.journey === null) {
      return ' '
    }

    const candidate = journeyAlertAt(journeyState.journey, atMs)
    return candidate === undefined || dismissedAlertKeys.has(candidate.key)
      ? ' '
      : buildAlertContainerContent(candidate.content)
  }

  function dismissCurrentAlert(): void {
    if (!journeyState.active || journeyState.journey === null) {
      return
    }

    const candidate = journeyAlertAt(journeyState.journey, now())
    if (candidate !== undefined) {
      dismissedAlertKeys.add(candidate.key)
    }
  }

  const startupTime = now()
  const startupAlertContent = currentAlertContainerContent(startupTime)
  const initialStagePage = currentStagePage(startupTime)
  const startupJourneyVersion = initialStagePage === undefined
    ? undefined
    : journeyStateVersion
  const startupContainers = initialStagePage === undefined
    ? createStatusContainers()
    : journeyState.hudHidden
      ? createHiddenContainers(startupAlertContent)
      : createStageContainers(initialStagePage, startupAlertContent)

  function withBridgeTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new BridgeTimeoutError(`${label} timed out after ${BRIDGE_TIMEOUT_MS}ms`)),
        BRIDGE_TIMEOUT_MS,
      )
    })

    return Promise.race([operation, timeout]).finally(() => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
    })
  }

  const result = await withBridgeTimeout(
    bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: startupContainers.length,
        textObject: startupContainers,
      }),
    ),
    'createStartUpPageContainer',
  )
  console.log('createStartUpPageContainer result:', result)

  let isUpdating = false
  let lastGoodBoard: string | undefined
  let lastGoodUpdateAt: number | undefined
  let refreshInterval: ReturnType<typeof setInterval> | undefined
  let exitRequestPending: Promise<boolean> | null = null
  let exitRequestQueued = false
  let bridgeCallPending: Promise<unknown> | null = null
  let journeyRenderQueued = false
  let journeyRenderInFlight = false
  let statusRenderQueued = false
  let statusRenderInFlight = false
  let hiddenClearQueued = false
  let hiddenNoticeTimer: ReturnType<typeof setTimeout> | undefined
  let journeyTickInterval: ReturnType<typeof setInterval> | undefined
  let desiredAlertContent = startupAlertContent
  let renderedAlertContent = initialStagePage === undefined
    ? undefined
    : startupAlertContent
  let desiredBarContent = (
    initialStagePage?.type === 'ride'
    && !journeyState.hudHidden
  )
    ? initialStagePage.bottomBar.content
    : undefined
  let renderedBarContent = desiredBarContent
  let liveUpdateQueued = false
  let liveUpdateInFlight = false

  function startBridgeCall<T>(
    label: string,
    createCall: () => Promise<T>,
  ): Promise<T> | undefined {
    if (bridgeCallPending !== null) {
      console.warn(`Skipping ${label} while the previous raw bridge call is still pending`)
      return undefined
    }

    const rawBridgeCall = createCall()
    bridgeCallPending = rawBridgeCall
    console.log(`${label} entered the serialised bridge gate`)
    void rawBridgeCall.finally(() => {
      bridgeCallPending = null
      if (exitRequestQueued) {
        void flushExitRequest()
      } else if (statusRenderQueued) {
        void flushStatusBoardRender()
      } else if (journeyRenderQueued) {
        void flushJourneyRender()
      } else if (liveUpdateQueued) {
        void flushLiveUpdates()
      } else {
        void flushHiddenNoticeClear()
      }
    }).catch(() => undefined)
    return rawBridgeCall
  }

  function formatBoard(lines: TflLineStatus[]): string {
    const boardLines: string[] = []

    for (const line of lines) {
      if (
        typeof line.name !== 'string'
        || typeof line.lineStatuses?.[0]?.statusSeverityDescription !== 'string'
      ) {
        continue
      }

      const name = cleanGlassesText(line.name)
        .slice(0, LINE_NAME_WIDTH)
        .padEnd(LINE_NAME_WIDTH)
      const status = cleanGlassesText(
        line.lineStatuses[0].statusSeverityDescription,
      )
      const nextLine = `${name} ${status}`
      const candidate = [...boardLines, nextLine].join('\n')

      if (candidate.length > MAX_BOARD_CHARACTERS) {
        console.warn(`Status board truncated after ${boardLines.length} lines`)
        break
      }

      boardLines.push(nextLine)
    }

    if (boardLines.length === 0) {
      throw new Error('TfL response contained no usable line statuses')
    }

    return boardLines.join('\n')
  }

  function staleBoard(): string {
    const board = lastGoodBoard ?? 'Loading line status...'

    if (lastGoodUpdateAt === undefined) {
      return `${board}\n(!) data unavailable`
    }

    const minutesOld = Math.max(1, Math.floor((now() - lastGoodUpdateAt) / 60_000))
    return `${board}\n(!) data ${minutesOld} min old`
  }

  async function updateStatusContainer(content: string): Promise<boolean> {
    const rawBridgeCall = startBridgeCall(
      'Status update',
      () => bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'status',
          content,
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    )
    if (rawBridgeCall === undefined) {
      return false
    }

    await withBridgeTimeout(rawBridgeCall, 'textContainerUpgrade')
    return true
  }

  async function refreshStatuses(): Promise<void> {
    if (journeyState.active) {
      return
    }

    if (isUpdating) {
      console.warn('Skipping refresh while the previous update is still in flight')
      return
    }

    isUpdating = true

    try {
      const response = await fetch(`${API_BASE}${STATUS_PATH}`)
      if (!response.ok) {
        throw new Error(`TfL request failed with HTTP ${response.status}`)
      }

      const lines: unknown = await response.json()
      if (!Array.isArray(lines)) {
        throw new Error('TfL response was not an array')
      }

      const board = formatBoard(lines as TflLineStatus[])
      if (journeyState.active) {
        return
      }

      const wasUpdated = await updateStatusContainer(board)
      if (!wasUpdated) {
        return
      }

      lastGoodBoard = board
      lastGoodUpdateAt = now()
    } catch (error) {
      console.error('Unable to refresh TfL line status:', error)

      if (error instanceof BridgeTimeoutError || journeyState.active) {
        return
      }

      try {
        await updateStatusContainer(staleBoard())
      } catch (staleError) {
        console.error('Unable to show stale status marker:', staleError)
      }
    } finally {
      isUpdating = false
    }
  }

  function startRefreshInterval(): void {
    if (refreshInterval !== undefined) {
      return
    }

    refreshInterval = setInterval(() => {
      void refreshStatuses()
    }, REFRESH_INTERVAL_MS)
    console.log('Status refresh interval resumed')
  }

  function pauseRefreshInterval(): void {
    if (refreshInterval === undefined) {
      return
    }

    clearInterval(refreshInterval)
    refreshInterval = undefined
    console.log('Status refresh interval paused')
  }

  function hasPendingLiveUpdate(): boolean {
    return renderedAlertContent !== desiredAlertContent
      || (
        desiredBarContent !== undefined
        && renderedBarContent !== desiredBarContent
      )
  }

  function evaluateJourneyLiveState(): void {
    if (!journeyState.active || journeyState.journey === null) {
      stopJourneyTick()
      return
    }

    const tickTime = now()
    desiredAlertContent = currentAlertContainerContent(tickTime)
    if (journeyState.hudHidden) {
      desiredBarContent = undefined
    } else {
      const page = currentStagePage(tickTime)
      desiredBarContent = page?.type === 'ride'
        ? page.bottomBar.content
        : undefined
    }

    liveUpdateQueued = hasPendingLiveUpdate()
    void flushLiveUpdates()
  }

  function startJourneyTick(): void {
    if (
      journeyTickInterval !== undefined
      || !journeyState.active
    ) {
      return
    }

    evaluateJourneyLiveState()
    journeyTickInterval = setInterval(
      evaluateJourneyLiveState,
      JOURNEY_TICK_MS,
    )
    console.log('Journey live tick started')
  }

  function stopJourneyTick(): void {
    if (journeyTickInterval === undefined) {
      return
    }

    clearInterval(journeyTickInterval)
    journeyTickInterval = undefined
    liveUpdateQueued = false
    console.log('Journey live tick stopped')
  }

  async function flushLiveUpdates(): Promise<void> {
    if (
      !liveUpdateQueued
      || liveUpdateInFlight
      || bridgeCallPending !== null
      || statusRenderQueued
      || statusRenderInFlight
      || journeyRenderQueued
      || journeyRenderInFlight
      || !journeyState.active
    ) {
      return
    }

    const isAlertUpdate = renderedAlertContent !== desiredAlertContent
    const targetContent = isAlertUpdate
      ? desiredAlertContent
      : desiredBarContent
    if (targetContent === undefined) {
      liveUpdateQueued = false
      return
    }

    const label = isAlertUpdate ? 'Journey alert update' : 'Live bar update'
    const containerID = isAlertUpdate ? 8 : 6
    const containerName = isAlertUpdate ? 'alert' : 'bar'
    liveUpdateInFlight = true

    const rawBridgeCall = startBridgeCall(
      label,
      () => bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID,
          containerName,
          content: targetContent,
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    )
    if (rawBridgeCall === undefined) {
      liveUpdateInFlight = false
      return
    }

    try {
      const wasUpdated = await withBridgeTimeout(
        rawBridgeCall,
        `${containerName} textContainerUpgrade`,
      )
      if (!wasUpdated) {
        console.error(`${label} failed`)
        liveUpdateQueued = false
        return
      }

      if (isAlertUpdate) {
        renderedAlertContent = targetContent
      } else {
        renderedBarContent = targetContent
      }
    } catch (error) {
      liveUpdateQueued = false
      console.error(`Unable to send ${label.toLowerCase()}:`, error)
      return
    } finally {
      liveUpdateInFlight = false
    }

    liveUpdateQueued = hasPendingLiveUpdate()
    if (liveUpdateQueued) {
      void flushLiveUpdates()
    }
  }

  function cancelHiddenNoticeTimer(): void {
    if (hiddenNoticeTimer !== undefined) {
      clearTimeout(hiddenNoticeTimer)
      hiddenNoticeTimer = undefined
    }
    hiddenClearQueued = false
  }

  function scheduleHiddenNoticeClear(): void {
    cancelHiddenNoticeTimer()
    if (!journeyState.active || !journeyState.hudHidden) {
      return
    }

    hiddenNoticeTimer = setTimeout(() => {
      hiddenNoticeTimer = undefined
      hiddenClearQueued = true
      void flushHiddenNoticeClear()
    }, HIDDEN_NOTICE_MS)
  }

  async function flushHiddenNoticeClear(): Promise<void> {
    if (!hiddenClearQueued || bridgeCallPending !== null) {
      return
    }
    if (!journeyState.active || !journeyState.hudHidden) {
      hiddenClearQueued = false
      return
    }

    const rawBridgeCall = startBridgeCall(
      'Hidden HUD notice clear',
      () => bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'hidden',
          content: ' ',
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    )
    if (rawBridgeCall === undefined) {
      return
    }

    hiddenClearQueued = false
    try {
      const wasUpdated = await withBridgeTimeout(
        rawBridgeCall,
        'hidden textContainerUpgrade',
      )
      if (!wasUpdated) {
        console.error('Hidden HUD notice clear failed')
      }
    } catch (error) {
      console.error('Unable to clear hidden HUD notice:', error)
    }
  }

  function requestJourneyRender(): void {
    cancelHiddenNoticeTimer()
    pauseRefreshInterval()
    journeyRenderQueued = true
    startJourneyTick()
    console.log('Status refresh paused for journey mode')
    void flushJourneyRender()
  }

  function requestStatusBoardRender(): void {
    cancelHiddenNoticeTimer()
    stopJourneyTick()
    journeyRenderQueued = false
    liveUpdateQueued = false
    hiddenClearQueued = false
    desiredBarContent = undefined
    desiredAlertContent = ' '
    statusRenderQueued = true
    pauseRefreshInterval()
    console.log('Returning glasses to status board')
    void flushStatusBoardRender()
  }

  async function flushStatusBoardRender(): Promise<void> {
    if (
      !statusRenderQueued
      || statusRenderInFlight
      || bridgeCallPending !== null
    ) {
      return
    }

    const containers = createStatusContainers()
    statusRenderInFlight = true
    const rawBridgeCall = startBridgeCall(
      'Status board rebuild',
      () => bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: containers.length,
          textObject: containers,
        }),
      ),
    )
    if (rawBridgeCall === undefined) {
      statusRenderInFlight = false
      return
    }

    statusRenderQueued = false
    try {
      const wasRebuilt = await withBridgeTimeout(
        rawBridgeCall,
        'status rebuildPageContainer',
      )
      if (!wasRebuilt) {
        console.error('Status board rebuild failed')
        return
      }

      renderedAlertContent = undefined
      renderedBarContent = undefined
      console.log('Status board restored after journey')
      setTimeout(() => {
        void refreshStatuses()
        startRefreshInterval()
      }, 0)
    } catch (error) {
      console.error('Unable to rebuild the status board:', error)
    } finally {
      statusRenderInFlight = false
    }
  }

  async function flushJourneyRender(): Promise<void> {
    if (
      !journeyRenderQueued
      || journeyRenderInFlight
      || bridgeCallPending !== null
      || statusRenderQueued
      || statusRenderInFlight
    ) {
      return
    }

    const renderVersion = journeyStateVersion
    const renderTime = now()
    const renderAlertContent = currentAlertContainerContent(renderTime)
    let renderBarContent: string | undefined
    let containers: TextContainerProperty[]
    try {
      if (journeyState.hudHidden) {
        containers = createHiddenContainers(renderAlertContent)
      } else {
        const page = currentStagePage(renderTime)
        if (page === undefined) {
          journeyRenderQueued = false
          return
        }
        renderBarContent = page.type === 'ride'
          ? page.bottomBar.content
          : undefined
        containers = createStageContainers(page, renderAlertContent)
      }
    } catch (error) {
      journeyRenderQueued = false
      console.error('Unable to construct journey stage:', error)
      return
    }

    journeyRenderInFlight = true
    const rawBridgeCall = startBridgeCall(
      'Journey stage rebuild',
      () => bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: containers.length,
          textObject: containers,
        }),
      ),
    )
    if (rawBridgeCall === undefined) {
      journeyRenderInFlight = false
      return
    }

    journeyRenderQueued = false
    try {
      const wasRebuilt = await withBridgeTimeout(rawBridgeCall, 'rebuildPageContainer')
      if (!wasRebuilt) {
        console.error('Journey stage rebuild failed')
      } else {
        renderedAlertContent = renderAlertContent
        renderedBarContent = renderBarContent
        if (
          journeyState.hudHidden
          && journeyStateVersion === renderVersion
        ) {
          scheduleHiddenNoticeClear()
        }
      }
    } catch (error) {
      console.error('Unable to rebuild journey stage:', error)
    } finally {
      journeyRenderInFlight = false
      if (journeyRenderQueued) {
        void flushJourneyRender()
      } else {
        evaluateJourneyLiveState()
      }
    }
  }

  function moveJourneyStage(direction: 1 | -1): void {
    if (!journeyState.active || journeyState.journey === null) {
      return
    }

    if (journeyState.hudHidden) {
      console.log('Ignoring journey stage swipe while HUD is hidden')
      return
    }

    if (
      bridgeCallPending !== null
      || journeyRenderQueued
      || journeyRenderInFlight
      || liveUpdateInFlight
    ) {
      console.warn('Ignoring journey stage swipe while a bridge call is pending')
      return
    }

    const stages = deriveJourneyStages(journeyState.journey)
    const nextIndex = Math.min(
      Math.max(journeyState.stageIndex + direction, 0),
      Math.max(stages.length - 1, 0),
    )
    if (nextIndex === journeyState.stageIndex) {
      console.log('Journey stage swipe clamped')
      return
    }

    dismissCurrentAlert()
    journeyState = { ...journeyState, stageIndex: nextIndex }
    journeyStateVersion += 1
    journeyRenderRequest?.()
  }

  function toggleJourneyHud(): void {
    if (!journeyState.active) {
      return
    }

    journeyState = {
      ...journeyState,
      hudHidden: !journeyState.hudHidden,
    }
    journeyStateVersion += 1
    console.log(journeyState.hudHidden ? 'HUD hidden' : 'HUD shown')
    journeyRenderRequest?.()
  }

  async function requestExit(): Promise<void> {
    if (exitRequestPending !== null || exitRequestQueued) {
      console.warn('Exit dialog request already in flight')
      return
    }

    cancelHiddenNoticeTimer()
    console.log('Calling shutDownPageContainer(1)')
    exitRequestQueued = true
    await flushExitRequest()
  }

  async function flushExitRequest(): Promise<void> {
    if (!exitRequestQueued || bridgeCallPending !== null) {
      return
    }

    const rawRequest = startBridgeCall(
      'Exit dialog',
      () => bridge.shutDownPageContainer(1),
    )
    if (rawRequest === undefined) {
      return
    }

    exitRequestQueued = false
    exitRequestPending = rawRequest.finally(() => {
      exitRequestPending = null
    })

    try {
      await withBridgeTimeout(exitRequestPending, 'shutDownPageContainer')
    } catch (error) {
      console.error('Unable to open the exit dialog:', error)
    }
  }

  if (result === 0) {
    journeyRenderRequest = requestJourneyRender
    journeyEndRequest = requestStatusBoardRender
    hudTimerCancelRequest = cancelHiddenNoticeTimer
    journeyLiveResetRequest = () => {
      dismissedAlertKeys.clear()
    }

    const unsubscribe = bridge.onEvenHubEvent(event => {
      if (event.textEvent) {
        const type = event.textEvent.eventType ?? 0

        if (type === 1) {
          if (journeyState.active) {
            moveJourneyStage(1)
          } else {
            console.log('Swipe up')
          }
        } else if (type === 2) {
          if (journeyState.active) {
            moveJourneyStage(-1)
          } else {
            console.log('Swipe down')
          }
        }
      } else if (event.sysEvent) {
        const type = event.sysEvent.eventType ?? 0

        if (type === 0) {
          if (journeyState.active) {
            toggleJourneyHud()
          } else {
            console.log('Single tap')
          }
        } else if (type === 3) {
          void requestExit()
        } else if (type === 4) {
          console.log('Foreground entered')
          if (journeyState.active) {
            journeyRenderRequest?.()
          } else {
            void refreshStatuses()
            startRefreshInterval()
          }
        } else if (type === 5) {
          console.log('Foreground exited')
          cancelHiddenNoticeTimer()
          pauseRefreshInterval()
        } else if (type === 6 || type === 7) {
          console.log(type === 6 ? 'Abnormal exit' : 'System exit')
          cancelHiddenNoticeTimer()
          pauseRefreshInterval()
          stopJourneyTick()
          journeyRenderRequest = undefined
          journeyEndRequest = undefined
          hudTimerCancelRequest = undefined
          journeyLiveResetRequest = undefined
          unsubscribe()
        }
      }
    })

    if (journeyState.active) {
      startJourneyTick()
      if (startupJourneyVersion === journeyStateVersion) {
        pauseRefreshInterval()
        console.log('Status refresh paused for journey mode')
        if (journeyState.hudHidden) {
          scheduleHiddenNoticeClear()
        }
      } else {
        requestJourneyRender()
      }
    } else {
      await refreshStatuses()
      startRefreshInterval()
    }
  } else {
    console.error('Status refresh not started because page creation failed:', result)
  }
}
