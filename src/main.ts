import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  RebuildPageContainer,
} from '@evenrealities/even_hub_sdk'
import { initializePhoneUi, type Journey } from './phone'
import {
  buildStagePage,
  deriveJourneyStages,
  type StagePageContent,
} from './journey-mode'
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
let hudTimerCancelRequest: (() => void) | undefined

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

  if (journeyState.active) {
    journeyRenderRequest?.()
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

initializePhoneUi(API_BASE, enterJourneyMode)
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
  console.log('Journey handoff')
  journeyRenderRequest?.()
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

function currentStagePage(): StagePageContent | undefined {
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

  return buildStagePage(stages[stageIndex]!, stageIndex, stages.length)
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

function createStageContainers(page: StagePageContent): TextContainerProperty[] {
  const topLineCount = page.top.split('\n').length
  const containers = [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: topLineCount * 27,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 0,
      containerID: 1,
      containerName: 'header',
      content: page.top,
      isEventCapture: 1,
    }),
  ]

  if (page.bottom !== undefined) {
    containers.push(new TextContainerProperty({
      xPosition: 0,
      yPosition: 234,
      width: 576,
      height: 54,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 0,
      containerID: 2,
      containerName: 'bar',
      content: page.bottom,
      isEventCapture: 0,
    }))
  }

  return containers
}

function createHiddenContainers(): TextContainerProperty[] {
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
  ]
}

async function initializeGlasses(): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  const initialStagePage = currentStagePage()
  const startupJourneyVersion = initialStagePage === undefined
    ? undefined
    : journeyStateVersion
  const startupContainers = initialStagePage === undefined
    ? createStatusContainers()
    : journeyState.hudHidden
      ? createHiddenContainers()
      : createStageContainers(initialStagePage)

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
  let hiddenClearQueued = false
  let hiddenNoticeTimer: ReturnType<typeof setTimeout> | undefined

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
      } else if (journeyRenderQueued) {
        void flushJourneyRender()
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

      const name = line.name.slice(0, LINE_NAME_WIDTH).padEnd(LINE_NAME_WIDTH)
      const status = line.lineStatuses[0].statusSeverityDescription
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

    const minutesOld = Math.max(1, Math.floor((Date.now() - lastGoodUpdateAt) / 60_000))
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
      lastGoodUpdateAt = Date.now()
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
    console.log('Status refresh paused for journey mode')
    journeyRenderQueued = true
    void flushJourneyRender()
  }

  async function flushJourneyRender(): Promise<void> {
    if (!journeyRenderQueued || bridgeCallPending !== null) {
      return
    }

    const renderVersion = journeyStateVersion
    let containers: TextContainerProperty[]
    try {
      if (journeyState.hudHidden) {
        containers = createHiddenContainers()
      } else {
        const page = currentStagePage()
        if (page === undefined) {
          journeyRenderQueued = false
          return
        }
        containers = createStageContainers(page)
      }
    } catch (error) {
      journeyRenderQueued = false
      console.error('Unable to construct journey stage:', error)
      return
    }

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
      return
    }

    journeyRenderQueued = false
    try {
      const wasRebuilt = await withBridgeTimeout(rawBridgeCall, 'rebuildPageContainer')
      if (!wasRebuilt) {
        console.error('Journey stage rebuild failed')
      } else if (
        journeyState.hudHidden
        && journeyStateVersion === renderVersion
      ) {
        scheduleHiddenNoticeClear()
      }
    } catch (error) {
      console.error('Unable to rebuild journey stage:', error)
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

    if (bridgeCallPending !== null || journeyRenderQueued) {
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
    hudTimerCancelRequest = cancelHiddenNoticeTimer

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
          journeyRenderRequest = undefined
          hudTimerCancelRequest = undefined
          unsubscribe()
        }
      }
    })

    if (journeyState.active) {
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
