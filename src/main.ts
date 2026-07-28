import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk'

export const API_BASE = 'https://api.tfl.gov.uk'

const STATUS_PATH = '/Line/Mode/tube,elizabeth-line,dlr,overground/Status'
const REFRESH_INTERVAL_MS = 60_000
const BRIDGE_TIMEOUT_MS = 5_000
const MAX_BOARD_CHARACTERS = 475
const LINE_NAME_WIDTH = 13

interface TflLineStatus {
  name?: unknown
  lineStatuses?: Array<{
    statusSeverityDescription?: unknown
  }>
}

class BridgeTimeoutError extends Error {}

const bridge = await waitForEvenAppBridge()

const statusContainer = new TextContainerProperty({
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
})

const footerContainer = new TextContainerProperty({
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
})

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
      containerTotalNum: 2,
      textObject: [statusContainer, footerContainer],
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
let bridgeCallPending: Promise<unknown> | null = null

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
  if (bridgeCallPending !== null) {
    console.warn('Skipping status update while the previous raw bridge call is still pending')
    return false
  }

  const rawBridgeCall = bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'status',
      content,
      contentOffset: 0,
      contentLength: 0,
    }),
  )
  bridgeCallPending = rawBridgeCall
  void rawBridgeCall.finally(() => {
    bridgeCallPending = null
  }).catch(() => undefined)

  await withBridgeTimeout(rawBridgeCall, 'textContainerUpgrade')
  return true
}

async function refreshStatuses(): Promise<void> {
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
    const wasUpdated = await updateStatusContainer(board)
    if (!wasUpdated) {
      return
    }

    lastGoodBoard = board
    lastGoodUpdateAt = Date.now()
  } catch (error) {
    console.error('Unable to refresh TfL line status:', error)

    if (error instanceof BridgeTimeoutError) {
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

async function requestExit(): Promise<void> {
  if (exitRequestPending !== null) {
    console.warn('Exit dialog request already in flight')
    return
  }

  console.log('Calling shutDownPageContainer(1)')
  const rawRequest = bridge.shutDownPageContainer(1)
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
  const unsubscribe = bridge.onEvenHubEvent(event => {
    if (event.textEvent) {
      const type = event.textEvent.eventType ?? 0

      if (type === 1) {
        console.log('Swipe up')
      } else if (type === 2) {
        console.log('Swipe down')
      }
    } else if (event.sysEvent) {
      const type = event.sysEvent.eventType ?? 0

      if (type === 0) {
        console.log('Single tap')
      } else if (type === 3) {
        void requestExit()
      } else if (type === 4) {
        console.log('Foreground entered')
        void refreshStatuses()
        startRefreshInterval()
      } else if (type === 5) {
        console.log('Foreground exited')
        pauseRefreshInterval()
      } else if (type === 6 || type === 7) {
        console.log(type === 6 ? 'Abnormal exit' : 'System exit')
        pauseRefreshInterval()
        unsubscribe()
      }
    }
  })

  await refreshStatuses()
  startRefreshInterval()
} else {
  console.error('Status refresh not started because page creation failed:', result)
}
