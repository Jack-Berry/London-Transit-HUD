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

interface JourneyLeg {
  mode?: {
    name?: string
  }
  departurePoint?: {
    commonName?: string
  }
  arrivalPoint?: {
    commonName?: string
  }
}

interface Journey {
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
  input: HTMLInputElement
  suggestions: HTMLElement
  error: HTMLElement
  selected?: StationMatch
  debounce?: ReturnType<typeof setTimeout>
  abortController?: AbortController
}

class StopIdentificationError extends Error {}

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MODES = 'tube,elizabeth-line,dlr,overground,bus'
const SEARCH_RESULT_LIMIT = 8
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
})

let selectedJourney: Journey | undefined

export function initializePhoneUi(apiBase: string): void {
  const form = getElement<HTMLFormElement>('journey-form')
  const fromControl = createStationControl('from')
  const toControl = createStationControl('to')
  const datetimeField = getElement<HTMLElement>('datetime-field')
  const datetimeInput = getElement<HTMLInputElement>('journey-datetime')
  const plannerError = getElement<HTMLElement>('planner-error')
  const planButton = getElement<HTMLButtonElement>('plan-button')
  const resultsSection = getElement<HTMLElement>('results-section')
  const results = getElement<HTMLElement>('journey-results')
  const timingInputs = Array.from(
    form.querySelectorAll<HTMLInputElement>('input[name="timing"]'),
  )

  datetimeInput.min = toDatetimeLocalValue(new Date())
  datetimeInput.value = toDatetimeLocalValue(nextHalfHour())

  bindStationSearch(fromControl, apiBase)
  bindStationSearch(toControl, apiBase)

  for (const timingInput of timingInputs) {
    timingInput.addEventListener('change', () => {
      const isNow = selectedTiming(timingInputs) === 'now'
      datetimeField.hidden = isNow
      datetimeInput.required = !isNow
      plannerError.textContent = ''
    })
  }

  document.addEventListener('pointerdown', event => {
    const target = event.target
    if (!(target instanceof Node)) {
      return
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
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) {
    throw new Error(`Missing required phone UI element: ${id}`)
  }
  return element as T
}

function createStationControl(prefix: 'from' | 'to'): StationControl {
  return {
    input: getElement<HTMLInputElement>(`${prefix}-input`),
    suggestions: getElement<HTMLElement>(`${prefix}-suggestions`),
    error: getElement<HTMLElement>(`${prefix}-error`),
  }
}

function bindStationSearch(control: StationControl, apiBase: string): void {
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
      void searchStations(control, query, apiBase)
    }, SEARCH_DEBOUNCE_MS)
  })
}

async function searchStations(
  control: StationControl,
  query: string,
  apiBase: string,
): Promise<void> {
  const abortController = new AbortController()
  control.abortController = abortController

  try {
    const response = await fetch(
      `${apiBase}/StopPoint/Search/${encodeURIComponent(query)}?modes=${SEARCH_MODES}`,
      { signal: abortController.signal },
    )
    if (!response.ok) {
      throw new Error(`Station search failed with HTTP ${response.status}`)
    }

    const data = await response.json() as StationSearchResponse
    const matches = Array.isArray(data.matches)
      ? data.matches.filter(isStationMatch).slice(0, SEARCH_RESULT_LIMIT)
      : []

    if (control.input.value.trim() !== query) {
      return
    }

    renderSuggestions(control, matches)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return
    }

    hideSuggestions(control)
    control.error.textContent = 'Station search is unavailable. Try again.'
  } finally {
    if (control.abortController === abortController) {
      control.abortController = undefined
      control.input.parentElement?.classList.remove('is-loading')
    }
  }
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

function renderSuggestions(control: StationControl, matches: StationMatch[]): void {
  control.suggestions.replaceChildren()

  if (matches.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'suggestion-empty'
    empty.textContent = 'No matching stops found'
    control.suggestions.append(empty)
  } else {
    for (const match of matches) {
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
      option.addEventListener('click', () => selectStation(control, match))
      control.suggestions.append(option)
    }
  }

  control.suggestions.hidden = false
  control.input.setAttribute('aria-expanded', 'true')
}

function selectStation(control: StationControl, match: StationMatch): void {
  control.selected = match
  control.input.value = match.name
  control.input.dataset.selected = 'true'
  control.input.setAttribute('aria-invalid', 'false')
  control.error.textContent = ''
  hideSuggestions(control)
}

function hideSuggestions(control: StationControl): void {
  control.suggestions.hidden = true
  control.input.setAttribute('aria-expanded', 'false')
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
    encodeURIComponent(fromControl.selected.icsId)
  }/to/${encodeURIComponent(toControl.selected.icsId)}`
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
  const date = new Date()
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
