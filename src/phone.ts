import { now } from './clock'
import {
  activeJourneyStageIndexAt,
  deriveJourneyStages,
  estimatedRideStopTimes,
  type JourneyStage,
} from './journey-mode'

interface StationMatch {
  id: string
  icsId: string
  name: string
  lat: number
  lon: number
  modes: string[]
  zone: string
}

interface StationSearchResponse {
  matches?: StationMatch[]
}

interface PhotonFeature {
  geometry?: {
    coordinates?: unknown
  }
  properties?: {
    name?: unknown
    osm_value?: unknown
    street?: unknown
    postcode?: unknown
    city?: unknown
  }
}

interface PhotonResponse {
  features?: PhotonFeature[]
}

interface PlaceMatch {
  name: string
  lat: number
  lon: number
  osmValue: string
  secondary: string
}

type JourneySelection =
  | {
    kind: 'stop'
    name: string
    endpoint: string
    match: StationMatch
  }
  | {
    kind: 'place'
    name: string
    endpoint: string
    place: PlaceMatch
  }

export interface JourneyLeg {
  mode?: {
    name?: string
  }
  departurePoint?: {
    commonName?: string
  }
  arrivalPoint?: {
    commonName?: string
    lat?: number
    lon?: number
  }
  routeOptions?: Array<{
    name?: string
  }>
  instruction?: {
    summary?: string
  }
  departureTime?: string
  arrivalTime?: string
  duration?: number
  isDisrupted?: boolean
  disruptions?: unknown[]
  path?: {
    stopPoints?: Array<{
      id?: string
      name?: string
    }>
  }
}

export interface Journey {
  duration: number
  startDateTime: string
  arrivalDateTime: string
  fare?: {
    totalCost?: number
  }
  legs: JourneyLeg[]
}

interface JourneyResponse {
  journeys?: Journey[]
}

interface StationControl {
  field: HTMLElement
  input: HTMLInputElement
  suggestions: HTMLElement
  error: HTMLElement
  cancel: HTMLButtonElement
  shell: HTMLElement
  selected?: JourneySelection
  debounce?: ReturnType<typeof setTimeout>
  abortController?: AbortController
  hasScrolledForSuggestions: boolean
  onSelection: () => void
  stopViewportTracking?: () => void
}

class StopIdentificationError extends Error {}

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MODES = 'tube,elizabeth-line,dlr,overground,bus'
const SEARCH_RESULT_LIMIT = 8
const PLACE_RESULT_LIMIT = 5
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
})

let selectedJourney: Journey | undefined
let journeySelectionHandler: (journey: Journey) => void = () => undefined

export interface PhoneUiController {
  showActiveJourney: (journey: Journey) => void
  resetPlanner: () => void
}

export function initializePhoneUi(
  apiBase: string,
  onJourneySelected: (journey: Journey) => void,
  onJourneyEnded: () => void,
): PhoneUiController {
  const appShell = getElement<HTMLElement>('app-shell')
  const plannerView = getElement<HTMLElement>('planner-view')
  const activeView = getElement<HTMLElement>('active-journey-view')
  const activeSummary = getElement<HTMLElement>('active-journey-summary')
  const activeStageList = getElement<HTMLOListElement>('active-stage-list')
  const endJourneyButton = getElement<HTMLButtonElement>('end-journey-button')
  const form = getElement<HTMLFormElement>('journey-form')
  const fromControl = createStationControl('from', appShell)
  const toControl = createStationControl('to', appShell)
  const stationControls = [fromControl, toControl]
  const datetimeField = getElement<HTMLElement>('datetime-field')
  const datetimeInput = getElement<HTMLInputElement>('journey-datetime')
  const plannerError = getElement<HTMLElement>('planner-error')
  const planButton = getElement<HTMLButtonElement>('plan-button')
  const resultsSection = getElement<HTMLElement>('results-section')
  const results = getElement<HTMLElement>('journey-results')
  const timingInputs = Array.from(
    form.querySelectorAll<HTMLInputElement>('input[name="timing"]'),
  )
  let activeJourney: Journey | undefined
  let activeJourneyInterval: ReturnType<typeof setInterval> | undefined

  datetimeInput.min = toDatetimeLocalValue(new Date(now()))
  datetimeInput.value = toDatetimeLocalValue(nextHalfHour())

  let activeSearchControl: StationControl | undefined

  const enterSearchTakeover = (control: StationControl): void => {
    if (activeSearchControl !== undefined && activeSearchControl !== control) {
      cancelStationSearch(activeSearchControl)
      hideSuggestions(activeSearchControl)
      activeSearchControl.field.classList.remove('is-search-active')
      activeSearchControl.field.style.removeProperty('--search-shell-height')
    }

    activeSearchControl = control
    appShell.classList.add('search-active', 'input-focused')
    control.field.classList.add('is-search-active')
    control.field.style.setProperty(
      '--search-shell-height',
      `${appShell.clientHeight}px`,
    )
    appShell.scrollTop = 0
  }

  const exitSearchTakeover = (control: StationControl): void => {
    if (activeSearchControl !== control) {
      return
    }

    cancelStationSearch(control)
    hideSuggestions(control)

    const focusedElement = document.activeElement
    if (
      focusedElement instanceof HTMLElement
      && control.field.contains(focusedElement)
    ) {
      focusedElement.blur()
    }

    control.field.classList.remove('is-search-active')
    control.field.style.removeProperty('--search-shell-height')
    appShell.classList.remove('search-active', 'input-focused')
    activeSearchControl = undefined
    control.field.scrollIntoView({ block: 'start', behavior: 'auto' })
  }

  for (const control of stationControls) {
    control.onSelection = () => exitSearchTakeover(control)
    control.cancel.addEventListener('pointerdown', event => {
      event.preventDefault()
    })
    control.cancel.addEventListener('click', () => {
      exitSearchTakeover(control)
    })
    bindStationSearch(
      control,
      apiBase,
      () => enterSearchTakeover(control),
    )
  }

  form.addEventListener('focusin', event => {
    if (event.target instanceof HTMLInputElement) {
      appShell.classList.add('input-focused')
    }
  })

  form.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      const focusedElement = document.activeElement
      if (
        !appShell.classList.contains('search-active')
        && !(
          focusedElement instanceof HTMLInputElement
          && form.contains(focusedElement)
        )
      ) {
        appShell.classList.remove('input-focused')
      }
    })
  })

  for (const timingInput of timingInputs) {
    timingInput.addEventListener('change', () => {
      const isNow = selectedTiming(timingInputs) === 'now'
      datetimeField.hidden = isNow
      datetimeInput.required = !isNow
      plannerError.textContent = ''
    })
  }

  const stopActiveJourneyTick = (): void => {
    if (activeJourneyInterval !== undefined) {
      clearInterval(activeJourneyInterval)
      activeJourneyInterval = undefined
    }
  }

  const updateActiveStage = (): void => {
    if (activeJourney === undefined) {
      return
    }

    const tickTime = now()
    const activeIndex = activeJourneyStageIndexAt(activeJourney, tickTime)
    activeStageList.querySelectorAll<HTMLElement>('.active-stage').forEach(
      (element, index) => {
        const isActive = index === activeIndex
        element.classList.toggle('is-live', isActive)
        if (isActive) {
          element.setAttribute('aria-current', 'step')
        } else {
          element.removeAttribute('aria-current')
        }
      },
    )
    updateActiveStopProgress(
      activeStageList,
      activeJourney,
      activeIndex,
      tickTime,
    )
  }

  const showActiveJourney = (journey: Journey): void => {
    activeJourney = journey
    renderActiveJourneySummary(activeSummary, journey)
    renderActiveJourneyStages(activeStageList, journey)
    plannerView.hidden = true
    activeView.hidden = false
    appShell.classList.remove('search-active', 'input-focused')
    appShell.scrollTop = 0
    updateActiveStage()
    stopActiveJourneyTick()
    activeJourneyInterval = setInterval(updateActiveStage, 10_000)
  }

  const resetPlanner = (): void => {
    stopActiveJourneyTick()
    activeJourney = undefined
    selectedJourney = undefined

    if (activeSearchControl !== undefined) {
      exitSearchTakeover(activeSearchControl)
    }
    for (const control of stationControls) {
      cancelStationSearch(control)
      hideSuggestions(control)
      control.selected = undefined
      control.input.value = ''
      control.input.removeAttribute('data-selected')
      control.input.setAttribute('aria-invalid', 'false')
      control.error.textContent = ''
    }

    form.reset()
    datetimeField.hidden = true
    datetimeInput.required = false
    datetimeInput.min = toDatetimeLocalValue(new Date(now()))
    datetimeInput.value = toDatetimeLocalValue(nextHalfHour())
    plannerError.textContent = ''
    results.replaceChildren()
    resultsSection.hidden = true
    setPlanningState(planButton, false)
    activeSummary.replaceChildren()
    activeStageList.replaceChildren()
    activeView.hidden = true
    plannerView.hidden = false
    appShell.classList.remove('search-active', 'input-focused')
    appShell.scrollTop = 0
  }

  journeySelectionHandler = journey => {
    onJourneySelected(journey)
  }

  endJourneyButton.addEventListener('click', () => {
    onJourneyEnded()
    resetPlanner()
  })

  document.addEventListener('pointerdown', event => {
    const target = event.target
    if (!(target instanceof Node)) {
      return
    }

    if (
      activeSearchControl !== undefined
      && !activeSearchControl.field.contains(target)
    ) {
      exitSearchTakeover(activeSearchControl)
    }

    if (!fromControl.suggestions.contains(target) && target !== fromControl.input) {
      hideSuggestions(fromControl)
    }
    if (!toControl.suggestions.contains(target) && target !== toControl.input) {
      hideSuggestions(toControl)
    }
  })

  form.addEventListener('submit', event => {
    event.preventDefault()
    void planJourney({
      apiBase,
      fromControl,
      toControl,
      datetimeInput,
      timing: selectedTiming(timingInputs),
      plannerError,
      planButton,
      resultsSection,
      results,
    })
  })

  return {
    showActiveJourney,
    resetPlanner,
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) {
    throw new Error(`Missing required phone UI element: ${id}`)
  }
  return element as T
}

function createStationControl(
  prefix: 'from' | 'to',
  shell: HTMLElement,
): StationControl {
  const input = getElement<HTMLInputElement>(`${prefix}-input`)
  const field = input.closest<HTMLElement>('.station-field')
  if (field === null) {
    throw new Error(`Missing station field for ${prefix}`)
  }

  return {
    field,
    input,
    suggestions: getElement<HTMLElement>(`${prefix}-suggestions`),
    error: getElement<HTMLElement>(`${prefix}-error`),
    cancel: getElement<HTMLButtonElement>(`${prefix}-search-cancel`),
    shell,
    hasScrolledForSuggestions: false,
    onSelection: () => undefined,
  }
}

function bindStationSearch(
  control: StationControl,
  apiBase: string,
  onFocus: () => void,
): void {
  control.input.addEventListener('focus', () => {
    onFocus()
    control.hasScrolledForSuggestions = false
    scheduleStationFieldScroll(control)
  })

  control.input.addEventListener('input', () => {
    control.selected = undefined
    control.error.textContent = ''
    control.input.removeAttribute('data-selected')
    control.input.setAttribute('aria-invalid', 'false')

    if (control.debounce !== undefined) {
      clearTimeout(control.debounce)
    }
    control.abortController?.abort()

    const query = control.input.value.trim()
    if (query.length < 2) {
      hideSuggestions(control)
      return
    }

    control.input.parentElement?.classList.add('is-loading')
    control.debounce = setTimeout(() => {
      control.debounce = undefined
      void searchDestinations(control, query, apiBase)
    }, SEARCH_DEBOUNCE_MS)
  })
}

function cancelStationSearch(control: StationControl): void {
  if (control.debounce !== undefined) {
    clearTimeout(control.debounce)
    control.debounce = undefined
  }
  control.abortController?.abort()
  control.input.parentElement?.classList.remove('is-loading')
}

async function searchDestinations(
  control: StationControl,
  query: string,
  apiBase: string,
): Promise<void> {
  const abortController = new AbortController()
  control.abortController = abortController

  try {
    const [stopsResult, placesResult] = await Promise.allSettled([
      fetchStationMatches(query, apiBase, abortController.signal),
      fetchPlaceMatches(query, apiBase, abortController.signal),
    ])

    if (abortController.signal.aborted) {
      return
    }

    if (control.input.value.trim() !== query) {
      return
    }

    if (stopsResult.status === 'rejected' && placesResult.status === 'rejected') {
      hideSuggestions(control)
      control.error.textContent = 'Search is unavailable. Try again.'
      return
    }

    const stops = stopsResult.status === 'fulfilled' ? stopsResult.value : []
    const places = placesResult.status === 'fulfilled' ? placesResult.value : []
    renderSuggestions(control, stops, places)
  } finally {
    if (control.abortController === abortController) {
      control.abortController = undefined
      control.input.parentElement?.classList.remove('is-loading')
    }
  }
}

async function fetchStationMatches(
  query: string,
  apiBase: string,
  signal: AbortSignal,
): Promise<StationMatch[]> {
  const response = await fetch(
    `${apiBase}/StopPoint/Search/${encodeURIComponent(query)}?modes=${SEARCH_MODES}`,
    { signal },
  )
  if (!response.ok) {
    throw new Error(`Station search failed with HTTP ${response.status}`)
  }

  const data = await response.json() as StationSearchResponse
  return Array.isArray(data.matches)
    ? data.matches.filter(isStationMatch).slice(0, SEARCH_RESULT_LIMIT)
    : []
}

async function fetchPlaceMatches(
  query: string,
  apiBase: string,
  signal: AbortSignal,
): Promise<PlaceMatch[]> {
  const geocodeUrl = new URL('/geocode', apiBase)
  geocodeUrl.searchParams.set('q', query)

  const response = await fetch(geocodeUrl, { signal })
  if (!response.ok) {
    throw new Error(`Place search failed with HTTP ${response.status}`)
  }

  const data = await response.json() as PhotonResponse
  return Array.isArray(data.features)
    ? data.features.map(toPlaceMatch).filter(isPresent).slice(0, PLACE_RESULT_LIMIT)
    : []
}

function toPlaceMatch(feature: PhotonFeature): PlaceMatch | undefined {
  const coordinates = feature.geometry?.coordinates
  const properties = feature.properties
  if (
    !Array.isArray(coordinates)
    || typeof coordinates[0] !== 'number'
    || !Number.isFinite(coordinates[0])
    || typeof coordinates[1] !== 'number'
    || !Number.isFinite(coordinates[1])
    || typeof properties?.name !== 'string'
    || properties.name.trim() === ''
  ) {
    return undefined
  }

  const [lon, lat] = coordinates
  const street = typeof properties.street === 'string' ? properties.street : ''
  const postcode = typeof properties.postcode === 'string' ? properties.postcode : ''
  const city = typeof properties.city === 'string' ? properties.city : ''

  return {
    name: properties.name,
    lat,
    lon,
    osmValue: typeof properties.osm_value === 'string' ? properties.osm_value : 'place',
    secondary: [street, postcode || city].filter(Boolean).join(' · '),
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function isStationMatch(value: unknown): value is StationMatch {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<StationMatch>
  return typeof candidate.id === 'string'
    && typeof candidate.icsId === 'string'
    && candidate.icsId.length > 0
    && typeof candidate.name === 'string'
    && Array.isArray(candidate.modes)
}

function renderSuggestions(
  control: StationControl,
  stops: StationMatch[],
  places: PlaceMatch[],
): void {
  control.suggestions.replaceChildren()

  if (stops.length === 0 && places.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'suggestion-empty'
    empty.textContent = 'No matching stops or places found'
    control.suggestions.append(empty)
  }

  if (stops.length > 0) {
    control.suggestions.append(createSuggestionHeading('Stations & stops'))
    for (const match of stops) {
      control.suggestions.append(createStopOption(control, match))
    }
  }

  if (places.length > 0) {
    control.suggestions.append(createSuggestionHeading('Places'))
    for (const place of places) {
      control.suggestions.append(createPlaceOption(control, place))
    }
  }

  control.suggestions.hidden = false
  control.input.setAttribute('aria-expanded', 'true')
  startSuggestionViewportTracking(control)

  if (
    !control.hasScrolledForSuggestions
    && document.activeElement === control.input
  ) {
    control.hasScrolledForSuggestions = true
    scheduleStationFieldScroll(control)
  }
}

function createSuggestionHeading(label: string): HTMLElement {
  const heading = document.createElement('p')
  heading.className = 'suggestion-heading'
  heading.textContent = label
  return heading
}

function createStopOption(control: StationControl, match: StationMatch): HTMLElement {
  const option = document.createElement('button')
  option.type = 'button'
  option.className = 'suggestion-option'
  option.setAttribute('role', 'option')

  const name = document.createElement('span')
  name.className = 'suggestion-name'
  name.textContent = match.name

  const chips = document.createElement('span')
  chips.className = 'mode-list mode-list--compact'
  for (const mode of uniqueModes(match.modes)) {
    chips.append(createModeChip(mode))
  }

  option.append(name, chips)
  bindSuggestionSelection(option, control, {
    kind: 'stop',
    name: match.name,
    endpoint: match.icsId,
    match,
  })
  return option
}

function createPlaceOption(control: StationControl, place: PlaceMatch): HTMLElement {
  const option = document.createElement('button')
  option.type = 'button'
  option.className = 'suggestion-option suggestion-option--place'
  option.setAttribute('role', 'option')

  const copy = document.createElement('span')
  copy.className = 'place-copy'

  const name = document.createElement('span')
  name.className = 'suggestion-name'
  name.textContent = place.name

  const secondary = document.createElement('span')
  secondary.className = 'place-secondary'
  secondary.textContent = place.secondary
  secondary.hidden = place.secondary === ''

  const type = document.createElement('span')
  type.className = 'place-type'
  type.textContent = place.osmValue

  copy.append(name, secondary)
  option.append(copy, type)
  bindSuggestionSelection(option, control, {
    kind: 'place',
    name: place.name,
    endpoint: `${place.lat},${place.lon}`,
    place,
  })
  return option
}

function bindSuggestionSelection(
  option: HTMLButtonElement,
  control: StationControl,
  selection: JourneySelection,
): void {
  option.addEventListener('pointerdown', event => {
    event.preventDefault()
    selectDestination(control, selection)
  })
  option.addEventListener('click', () => {
    if (control.selected !== selection) {
      selectDestination(control, selection)
    }
  })
}

function selectDestination(control: StationControl, selection: JourneySelection): void {
  control.selected = selection
  control.input.value = selection.name
  control.input.dataset.selected = 'true'
  control.input.setAttribute('aria-invalid', 'false')
  control.error.textContent = ''
  hideSuggestions(control)
  control.onSelection()
}

function hideSuggestions(control: StationControl): void {
  control.suggestions.hidden = true
  control.input.setAttribute('aria-expanded', 'false')
  control.stopViewportTracking?.()
  control.stopViewportTracking = undefined
  control.suggestions.style.removeProperty('max-height')
}

function scheduleStationFieldScroll(control: StationControl): void {
  setTimeout(() => {
    if (document.activeElement !== control.input) {
      return
    }

    control.input.closest<HTMLElement>('.station-field')?.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    })
  }, 300)
}

function startSuggestionViewportTracking(control: StationControl): void {
  control.stopViewportTracking?.()

  const visualViewport = window.visualViewport
  const updateMaxHeight = (): void => {
    if (control.field.classList.contains('is-search-active')) {
      control.field.style.setProperty(
        '--search-shell-height',
        `${control.shell.clientHeight}px`,
      )
    }

    const listTop = control.suggestions.getBoundingClientRect().top
    const visualViewportHeight = visualViewport?.height
      ?? window.innerHeight * 0.4
    const viewportAvailableHeight = visualViewportHeight - listTop - 12
    const shellAvailableHeight = control.shell.clientHeight - listTop - 12
    const availableHeight = Math.max(
      120,
      Math.floor(Math.min(viewportAvailableHeight, shellAvailableHeight)),
    )
    control.suggestions.style.maxHeight = `${availableHeight}px`
  }

  updateMaxHeight()
  visualViewport?.addEventListener('resize', updateMaxHeight)
  visualViewport?.addEventListener('scroll', updateMaxHeight)
  window.addEventListener('resize', updateMaxHeight)
  control.stopViewportTracking = () => {
    visualViewport?.removeEventListener('resize', updateMaxHeight)
    visualViewport?.removeEventListener('scroll', updateMaxHeight)
    window.removeEventListener('resize', updateMaxHeight)
  }
}

function uniqueModes(modes: string[]): string[] {
  return [...new Set(modes)].slice(0, 4)
}

function selectedTiming(inputs: HTMLInputElement[]): string {
  return inputs.find(input => input.checked)?.value ?? 'now'
}

interface PlanJourneyOptions {
  apiBase: string
  fromControl: StationControl
  toControl: StationControl
  datetimeInput: HTMLInputElement
  timing: string
  plannerError: HTMLElement
  planButton: HTMLButtonElement
  resultsSection: HTMLElement
  results: HTMLElement
}

async function planJourney(options: PlanJourneyOptions): Promise<void> {
  const {
    apiBase,
    fromControl,
    toControl,
    datetimeInput,
    timing,
    plannerError,
    planButton,
    resultsSection,
    results,
  } = options

  plannerError.textContent = ''
  let isValid = true

  if (fromControl.selected === undefined) {
    showSelectionError(fromControl)
    isValid = false
  }
  if (toControl.selected === undefined) {
    showSelectionError(toControl)
    isValid = false
  }
  if (timing !== 'now' && datetimeInput.value === '') {
    plannerError.textContent = 'Choose a date and time for this journey.'
    isValid = false
  }
  if (!isValid || fromControl.selected === undefined || toControl.selected === undefined) {
    return
  }

  const timingParams = buildTimingParams(timing, datetimeInput.value)
  const journeyPath = `${apiBase}/Journey/JourneyResults/${
    encodeURIComponent(fromControl.selected.endpoint)
  }/to/${encodeURIComponent(toControl.selected.endpoint)}`
  const defaultUrl = withQuery(journeyPath, timingParams)
  const busParams = new URLSearchParams(timingParams)
  busParams.set('mode', 'bus')
  const busUrl = withQuery(journeyPath, busParams)

  setPlanningState(planButton, true)
  resultsSection.hidden = true
  results.replaceChildren()

  try {
    const [defaultResponse, busResponse] = await Promise.all([
      fetchJourneys(defaultUrl),
      fetchJourneys(busUrl),
    ])
    const defaultJourneys = validJourneys(defaultResponse.journeys)
    const busJourneys = validJourneys(busResponse.journeys)

    if (defaultJourneys.length === 0) {
      plannerError.textContent = 'No routes found'
      return
    }

    const fastest = defaultJourneys.reduce((best, journey) => (
      journey.duration < best.duration ? journey : best
    ))
    const cheapest = [...defaultJourneys, ...busJourneys]
      .filter(hasFare)
      .reduce<Journey | undefined>((best, journey) => (
        best === undefined || fareInPence(journey) < fareInPence(best) ? journey : best
      ), undefined)

    renderJourneyOptions(results, fastest, cheapest)
    resultsSection.hidden = false
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    if (error instanceof StopIdentificationError) {
      plannerError.textContent = "Couldn't identify that stop, pick it from the suggestions"
    } else {
      plannerError.textContent = 'Routes could not be loaded. Try again.'
    }
  } finally {
    setPlanningState(planButton, false)
  }
}

function showSelectionError(control: StationControl): void {
  control.error.textContent = 'Pick a stop from the suggestions.'
  control.input.setAttribute('aria-invalid', 'true')
}

function buildTimingParams(timing: string, datetimeValue: string): URLSearchParams {
  const params = new URLSearchParams()
  if (timing === 'now' || datetimeValue === '') {
    return params
  }

  const date = new Date(datetimeValue)
  params.set('date', [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join(''))
  params.set('time', [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(''))
  params.set('timeIs', timing === 'arriving' ? 'Arriving' : 'Departing')
  return params
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query === '' ? path : `${path}?${query}`
}

async function fetchJourneys(url: string): Promise<JourneyResponse> {
  const response = await fetch(url)
  if (response.status === 300) {
    throw new StopIdentificationError()
  }
  if (!response.ok) {
    throw new Error(`Journey request failed with HTTP ${response.status}`)
  }

  return await response.json() as JourneyResponse
}

function validJourneys(journeys: unknown): Journey[] {
  if (!Array.isArray(journeys)) {
    return []
  }

  return journeys.filter((journey): journey is Journey => {
    if (journey === null || typeof journey !== 'object') {
      return false
    }
    const candidate = journey as Partial<Journey>
    return typeof candidate.duration === 'number'
      && Number.isFinite(candidate.duration)
      && typeof candidate.startDateTime === 'string'
      && typeof candidate.arrivalDateTime === 'string'
      && Array.isArray(candidate.legs)
  })
}

function hasFare(journey: Journey): boolean {
  return typeof journey.fare?.totalCost === 'number'
    && Number.isFinite(journey.fare.totalCost)
}

function fareInPence(journey: Journey): number {
  return journey.fare?.totalCost ?? Number.POSITIVE_INFINITY
}

function renderJourneyOptions(
  container: HTMLElement,
  fastest: Journey,
  cheapest: Journey | undefined,
): void {
  container.replaceChildren()

  if (cheapest !== undefined && isSameJourney(fastest, cheapest)) {
    container.append(createJourneyCard('Fastest & cheapest', fastest, 'combined'))
    return
  }

  container.append(createJourneyCard('Fastest', fastest, 'fastest'))

  if (cheapest !== undefined) {
    container.append(createJourneyCard('Cheapest', cheapest, 'cheapest'))
  } else {
    const note = document.createElement('p')
    note.className = 'results-note'
    note.textContent = 'No fare-priced route was returned. The fastest option is still available.'
    container.append(note)
  }
}

function isSameJourney(first: Journey, second: Journey): boolean {
  return first.duration === second.duration
    && first.startDateTime === second.startDateTime
    && first.arrivalDateTime === second.arrivalDateTime
    && first.legs.map(legSignature).join('|') === second.legs.map(legSignature).join('|')
}

function legSignature(leg: JourneyLeg): string {
  return [
    leg.mode?.name ?? '',
    leg.departurePoint?.commonName ?? '',
    leg.arrivalPoint?.commonName ?? '',
  ].join(':')
}

function createJourneyCard(
  label: string,
  journey: Journey,
  variant: 'fastest' | 'cheapest' | 'combined',
): HTMLElement {
  const card = document.createElement('article')
  card.className = `journey-card journey-card--${variant}`

  const header = document.createElement('div')
  header.className = 'journey-card__header'

  const badge = document.createElement('span')
  badge.className = 'option-badge'
  badge.textContent = label

  const fare = document.createElement('span')
  fare.className = 'journey-fare'
  fare.textContent = formatFare(journey)
  header.append(badge, fare)

  const summary = document.createElement('div')
  summary.className = 'journey-summary'

  const duration = document.createElement('p')
  duration.className = 'journey-duration'
  duration.innerHTML = `<strong>${Math.round(journey.duration)}</strong><span>min</span>`

  const times = document.createElement('div')
  times.className = 'journey-times'
  times.append(
    createTime('Depart', journey.startDateTime),
    createTime('Arrive', journey.arrivalDateTime),
  )
  summary.append(duration, times)

  const legs = document.createElement('div')
  legs.className = 'leg-strip'
  legs.setAttribute('aria-label', 'Journey legs')

  journey.legs.forEach((leg, index) => {
    legs.append(createModeChip(leg.mode?.name ?? 'unknown'))

    if (index < journey.legs.length - 1) {
      const change = document.createElement('span')
      change.className = 'change-point'
      change.innerHTML = `<span aria-hidden="true">→</span><small>${
        escapeText(leg.arrivalPoint?.commonName ?? 'Change')
      }</small>`
      legs.append(change)
    }
  })

  const goButton = document.createElement('button')
  goButton.type = 'button'
  goButton.className = 'go-button'
  goButton.innerHTML = '<span>Choose this route</span><span aria-hidden="true">→</span>'
  goButton.addEventListener('click', () => {
    selectedJourney = journey
    console.log('Journey selected', selectedJourney)
    journeySelectionHandler(selectedJourney)

    document.querySelectorAll<HTMLButtonElement>('.go-button').forEach(button => {
      button.classList.remove('is-selected')
      button.setAttribute('aria-pressed', 'false')
      button.firstElementChild!.textContent = 'Choose this route'
    })
    goButton.classList.add('is-selected')
    goButton.setAttribute('aria-pressed', 'true')
    goButton.firstElementChild!.textContent = 'Route selected'
  })

  card.append(header, summary, legs, goButton)
  return card
}

function renderActiveJourneySummary(
  container: HTMLElement,
  journey: Journey,
): void {
  container.replaceChildren(
    createActiveSummaryItem('Depart', formatTimeValue(journey.startDateTime)),
    createActiveSummaryItem('Arrive', formatTimeValue(journey.arrivalDateTime)),
    createActiveSummaryItem('Duration', `${Math.round(journey.duration)} min`),
    createActiveSummaryItem('Fare', formatFare(journey)),
  )
}

function createActiveSummaryItem(label: string, value: string): HTMLElement {
  const item = document.createElement('div')
  const term = document.createElement('span')
  const detail = document.createElement('strong')
  term.textContent = label
  detail.textContent = value
  item.append(term, detail)
  return item
}

function renderActiveJourneyStages(
  container: HTMLOListElement,
  journey: Journey,
): void {
  const stages = deriveJourneyStages(journey)
  container.replaceChildren(...stages.map((stage, index) => (
    createActiveStage(stage, index, stages.length)
  )))
}

function createActiveStage(
  stage: JourneyStage,
  index: number,
  total: number,
): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'active-stage'
  item.dataset.stageIndex = String(index)

  const marker = document.createElement('span')
  marker.className = 'active-stage__marker'
  marker.textContent = String(index + 1)
  marker.setAttribute('aria-hidden', 'true')

  const content = document.createElement('article')
  content.className = 'active-stage__content'

  const eyebrow = document.createElement('div')
  eyebrow.className = 'active-stage__eyebrow'

  const stageNumber = document.createElement('span')
  stageNumber.className = 'active-stage__number'
  stageNumber.textContent = `Stage ${index + 1} of ${total}`

  if (stage.type === 'arrive') {
    eyebrow.append(stageNumber)
    const title = document.createElement('h2')
    title.textContent = 'Walk to your destination'
    content.append(eyebrow, title)
  } else {
    eyebrow.append(createModeChip(stage.leg.mode?.name ?? stage.type), stageNumber)

    const title = document.createElement('h2')
    title.textContent = stage.leg.instruction?.summary
      ?? (
        stage.type === 'walk'
          ? `Walk to ${stage.leg.arrivalPoint?.commonName ?? 'your next stop'}`
          : stage.leg.routeOptions?.[0]?.name ?? 'Journey stage'
      )
    content.append(eyebrow, title)

    if (stage.type === 'ride') {
      item.classList.add('active-stage--ride')
      const route = document.createElement('p')
      route.className = 'active-stage__route'
      route.append(
        createStageEndpoint(
          'From',
          cleanPhoneStopName(
            stage.leg.departurePoint?.commonName ?? 'Departure',
          ),
          stage.leg.departureTime,
        ),
        createStageArrow(),
        createStageEndpoint(
          'To',
          cleanPhoneStopName(
            stage.leg.arrivalPoint?.commonName ?? 'Arrival',
          ),
          stage.leg.arrivalTime,
        ),
      )

      const stops = stage.leg.path?.stopPoints?.length ?? 0
      const stopCount = document.createElement('p')
      stopCount.className = 'active-stage__meta'
      stopCount.textContent = `${stops} ${stops === 1 ? 'stop' : 'stops'}`

      const stopListId = `active-stop-list-${index}`
      const disclosure = document.createElement('button')
      disclosure.type = 'button'
      disclosure.className = 'stop-disclosure'
      disclosure.setAttribute('aria-expanded', 'false')
      disclosure.setAttribute('aria-controls', stopListId)
      disclosure.innerHTML = `<span>Show all ${stops + 1} stops</span><span aria-hidden="true">⌄</span>`

      const stopList = createActiveStopList(stage.leg, stopListId)
      disclosure.addEventListener('click', () => {
        const willExpand = disclosure.getAttribute('aria-expanded') !== 'true'
        disclosure.setAttribute('aria-expanded', String(willExpand))
        disclosure.firstElementChild!.textContent = willExpand
          ? 'Hide stops'
          : `Show all ${stops + 1} stops`
        stopList.hidden = !willExpand
      })
      content.append(route, stopCount, disclosure, stopList)
    } else {
      const duration = document.createElement('p')
      duration.className = 'active-stage__meta'
      duration.textContent = `About ${Math.round(stage.leg.duration ?? 0)} min`

      const mapsLink = document.createElement('a')
      mapsLink.className = 'maps-link'
      mapsLink.href = walkingMapsUrl(stage.leg)
      mapsLink.target = '_blank'
      mapsLink.rel = 'noopener noreferrer'
      mapsLink.textContent = 'Open in Google Maps'
      content.append(duration, mapsLink)
    }
  }

  item.append(marker, content)
  return item
}

function createActiveStopList(
  leg: JourneyLeg,
  id: string,
): HTMLOListElement {
  const stopNames = [
    leg.departurePoint?.commonName ?? 'Departure',
    ...(leg.path?.stopPoints ?? []).map(stop => stop.name ?? 'Stop'),
  ]
  const estimatedTimes = estimatedRideStopTimes(leg)
  const list = document.createElement('ol')
  list.id = id
  list.className = 'active-stop-list'
  list.hidden = true

  stopNames.forEach((stopName, index) => {
    const row = document.createElement('li')
    row.className = 'active-stop-row'
    row.dataset.stopIndex = String(index)

    const dot = document.createElement('span')
    dot.className = 'active-stop-row__dot'
    dot.setAttribute('aria-hidden', 'true')

    const name = document.createElement('span')
    name.className = 'active-stop-row__name'
    name.textContent = cleanPhoneStopName(stopName)

    const time = document.createElement('time')
    time.className = 'active-stop-row__time'
    const estimatedTime = estimatedTimes?.[index]
    time.textContent = estimatedTime === undefined
      ? '—'
      : timeFormatter.format(new Date(estimatedTime))
    row.append(dot, name, time)
    list.append(row)
  })

  return list
}

function updateActiveStopProgress(
  container: HTMLElement,
  journey: Journey,
  activeStageIndex: number,
  atMs: number,
): void {
  const stages = deriveJourneyStages(journey)

  container.querySelectorAll<HTMLElement>('.active-stage--ride').forEach(card => {
    const stageIndex = Number(card.dataset.stageIndex)
    const stage = stages[stageIndex]
    const rows = Array.from(
      card.querySelectorAll<HTMLElement>('.active-stop-row'),
    )
    for (const row of rows) {
      row.classList.remove('is-done', 'is-next')
    }

    if (
      stage?.type !== 'ride'
      || !Number.isInteger(stageIndex)
      || stageIndex > activeStageIndex
    ) {
      return
    }

    const estimatedTimes = estimatedRideStopTimes(stage.leg)
    if (estimatedTimes === undefined) {
      return
    }

    let nextIndex: number | undefined
    estimatedTimes.forEach((estimatedTime, index) => {
      if (estimatedTime <= atMs) {
        rows[index]?.classList.add('is-done')
      } else if (
        stageIndex === activeStageIndex
        && nextIndex === undefined
      ) {
        nextIndex = index
      }
    })
    if (nextIndex !== undefined) {
      rows[nextIndex]?.classList.add('is-next')
    }
  })
}

function cleanPhoneStopName(original: string): string {
  const cleaned = original
    .replace(/\b(?:Underground|Station)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, '')
    .trim()
  return cleaned === '' ? original : cleaned
}

function createStageEndpoint(
  label: string,
  name: string,
  time?: string,
): HTMLElement {
  const endpoint = document.createElement('span')
  const labelElement = document.createElement('small')
  const nameElement = document.createElement('strong')
  const timeElement = document.createElement('time')
  labelElement.textContent = label
  nameElement.textContent = name
  timeElement.textContent = formatTimeValue(time)
  endpoint.append(labelElement, nameElement, timeElement)
  return endpoint
}

function createStageArrow(): HTMLElement {
  const arrow = document.createElement('span')
  arrow.className = 'active-stage__arrow'
  arrow.setAttribute('aria-hidden', 'true')
  arrow.textContent = '→'
  return arrow
}

function walkingMapsUrl(leg: JourneyLeg): string {
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  const latitude = leg.arrivalPoint?.lat
  const longitude = leg.arrivalPoint?.lon
  const destination = (
    typeof latitude === 'number'
    && Number.isFinite(latitude)
    && typeof longitude === 'number'
    && Number.isFinite(longitude)
  )
    ? `${latitude},${longitude}`
    : leg.arrivalPoint?.commonName ?? 'Destination'
  url.searchParams.set('destination', destination)
  url.searchParams.set('travelmode', 'walking')
  return url.toString()
}

function formatTimeValue(value?: string): string {
  if (value === undefined) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : timeFormatter.format(date)
}

function createTime(label: string, value: string): HTMLElement {
  const item = document.createElement('p')
  const date = new Date(value)
  const formatted = Number.isNaN(date.getTime()) ? '—' : timeFormatter.format(date)
  item.innerHTML = `<span>${label}</span><strong>${formatted}</strong>`
  return item
}

function formatFare(journey: Journey): string {
  const totalCost = journey.fare?.totalCost
  return typeof totalCost === 'number' && Number.isFinite(totalCost)
    ? `£${(totalCost / 100).toFixed(2)}`
    : 'fare unavailable'
}

function createModeChip(mode: string): HTMLElement {
  const chip = document.createElement('span')
  const normalized = normalizeMode(mode)
  chip.className = `mode-chip mode-chip--${normalized}`
  chip.textContent = displayMode(mode)
  return chip
}

function normalizeMode(mode: string): string {
  const value = mode.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
  if (value === 'walk') {
    return 'walking'
  }
  if ([
    'tube',
    'elizabeth-line',
    'dlr',
    'overground',
    'bus',
    'national-rail',
    'walking',
  ].includes(value)) {
    return value
  }
  return 'other'
}

function displayMode(mode: string): string {
  const labels: Record<string, string> = {
    tube: 'Tube',
    'elizabeth-line': 'Elizabeth line',
    dlr: 'DLR',
    overground: 'Overground',
    bus: 'Bus',
    'national-rail': 'National Rail',
    walking: 'Walk',
    walk: 'Walk',
  }
  const normalized = mode.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
  return labels[normalized] ?? mode
}

function escapeText(value: string): string {
  const element = document.createElement('span')
  element.textContent = value
  return element.innerHTML
}

function setPlanningState(button: HTMLButtonElement, isPlanning: boolean): void {
  button.disabled = isPlanning
  button.classList.toggle('is-loading', isPlanning)
  button.firstElementChild!.textContent = isPlanning ? 'Finding your routes…' : 'Compare routes'
}

function nextHalfHour(): Date {
  const date = new Date(now())
  date.setSeconds(0, 0)
  date.setMinutes(Math.ceil((date.getMinutes() + 1) / 30) * 30)
  return date
}

function toDatetimeLocalValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}
