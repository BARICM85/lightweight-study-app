const ONLINE_API_BASE = 'https://tickertap-backend-88ts.onrender.com'
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : ONLINE_API_BASE)

export const DEFAULT_SYMBOL = {
  symbol: '^NSEI',
  name: 'NIFTY 50',
  exchange: 'INDEX',
  type: 'index',
}

export const INTERVAL_OPTIONS = ['1m', '5m', '15m', '1H', '4H', '1D', '1W', '1M']
export const RANGE_OPTIONS = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', 'ALL']
export const DAILY_ONLY_RANGE_OPTIONS = ['3Y', '6Y', '9Y', '12Y', '15Y', '18Y', '21Y']

const FALLBACK_SYMBOLS = [
  DEFAULT_SYMBOL,
  { symbol: '^NSEBANK', name: 'BANK NIFTY', exchange: 'INDEX', type: 'index' },
  { symbol: '^BSESN', name: 'SENSEX', exchange: 'INDEX', type: 'index' },
  { symbol: 'RELIANCE', name: 'Reliance Industries', exchange: 'NSE', type: 'stock' },
  { symbol: 'TCS', name: 'Tata Consultancy Services', exchange: 'NSE', type: 'stock' },
  { symbol: 'INFY', name: 'Infosys', exchange: 'NSE', type: 'stock' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', exchange: 'NSE', type: 'stock' },
]

const RANGE_TO_LOOKBACK = {
  '1D': '1d',
  '5D': '5d',
  '1M': '1mo',
  '3M': '3mo',
  '6M': '6mo',
  YTD: 'ytd',
  '1Y': '1y',
  '3Y': '3y',
  '6Y': '6y',
  '9Y': '9y',
  '12Y': '12y',
  '15Y': '15y',
  '18Y': '18y',
  '21Y': '21y',
  ALL: 'all',
}

const INTERVAL_TO_API = {
  '1m': '1minute',
  '5m': '5minute',
  '15m': '15minute',
  '1H': '60minute',
  '4H': '60minute',
  '1D': 'day',
  '1W': 'day',
  '1M': 'day',
}

function resolveHistoryRequestRange(range, interval, allowExtendedHistory = false) {
  if (range !== 'ALL') {
    if (DAILY_ONLY_RANGE_OPTIONS.includes(range) && !allowExtendedHistory) return '5y'
    return RANGE_TO_LOOKBACK[range] || 'ytd'
  }
  if (interval === '1D') return allowExtendedHistory ? 'all' : '5y'
  if (interval === '1W') return 'all'
  if (interval === '1M') return 'all'
  return '1y'
}

function apiUrl(path) {
  const base = DEFAULT_API_BASE.endsWith('/') ? DEFAULT_API_BASE.slice(0, -1) : DEFAULT_API_BASE
  return base ? `${base}${path}` : path
}

function seedFromSymbol(symbol) {
  return [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0)
}

function intervalToMs(interval) {
  const map = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '1H': 60 * 60 * 1000,
    '4H': 4 * 60 * 60 * 1000,
    '1D': 24 * 60 * 60 * 1000,
    '1W': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000,
  }
  return map[interval] || map['1D']
}

function fallbackSeries(symbol, interval = '1D', count = 240) {
  const seed = seedFromSymbol(symbol)
  const spacing = intervalToMs(interval)
  const now = Date.now()
  const anchor = Math.floor(now / spacing) * spacing
  const base = 900 + ((seed % 600) * 5)
  let previousClose = base

  return Array.from({ length: count }, (_, index) => {
    const timestamp = anchor - ((count - index) * spacing)
    const trend = Math.sin((index + seed) / 18) * (base * 0.014)
    const wave = Math.cos((index + seed) / 7) * (base * 0.008)
    const open = previousClose
    const close = Math.max(10, open + trend + wave + (((seed % 13) - 6) * 0.12))
    const high = Math.max(open, close) + Math.abs(Math.sin((seed + index) / 3.8) * (base * 0.01))
    const low = Math.min(open, close) - Math.abs(Math.cos((seed + index) / 4.1) * (base * 0.01))
    const volume = Math.round(100000 + ((seed * (index + 9)) % 550000))
    previousClose = close
    return {
      time: Math.floor(timestamp / 1000),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    }
  })
}

async function requestJson(path) {
  const response = await fetch(apiUrl(path))
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || 'Request failed')
  }
  return data
}

function resolveTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return asNumber > 1_000_000_000_000 ? Math.floor(asNumber / 1000) : asNumber
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return NaN
}

function toIndianSessionOpen(timestampSeconds) {
  if (!Number.isFinite(timestampSeconds)) return timestampSeconds
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampSeconds * 1000))
  const year = Number(parts.find((part) => part.type === 'year')?.value || 0)
  const month = Number(parts.find((part) => part.type === 'month')?.value || 1)
  const day = Number(parts.find((part) => part.type === 'day')?.value || 1)
  return Math.floor(Date.UTC(year, month - 1, day, 3, 45, 0) / 1000)
}

function normalizeHistory(payload, interval = '1D') {
  const points = Array.isArray(payload?.points) ? payload.points : Array.isArray(payload?.data) ? payload.data : []
  return points
    .map((point) => {
      const rawTime = resolveTimestamp(point.timestamp ?? point.date ?? point.time)
      const time = ['1D', '1W', '1M'].includes(interval) ? toIndianSessionOpen(rawTime) : rawTime
      const open = Number(point.open)
      const close = Number(point.close)
      const rawHigh = Number(point.high)
      const rawLow = Number(point.low)
      const highSeed = Number.isFinite(rawHigh) ? rawHigh : Math.max(open, close)
      const lowSeed = Number.isFinite(rawLow) ? rawLow : Math.min(open, close)
      const high = Math.max(highSeed, open, close)
      const low = Math.min(lowSeed, open, close)
      return {
        time,
        open,
        high,
        low,
        close,
        volume: Number(point.volume || 0),
      }
    })
    .filter((point) => (
      Number.isFinite(point.time)
      && Number.isFinite(point.open)
      && Number.isFinite(point.high)
      && Number.isFinite(point.low)
      && Number.isFinite(point.close)
      && point.open > 0
      && point.high > 0
      && point.low > 0
      && point.close > 0
      && point.high >= point.low
    ))
}

function startOfWeek(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000)
  const day = date.getUTCDay()
  const diff = (day + 6) % 7
  date.setUTCDate(date.getUTCDate() - diff)
  date.setUTCHours(0, 0, 0, 0)
  return Math.floor(date.getTime() / 1000)
}

function startOfMonth(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000)
  date.setUTCDate(1)
  date.setUTCHours(0, 0, 0, 0)
  return Math.floor(date.getTime() / 1000)
}

function aggregatePoints(points, interval) {
  if (!points.length) return points
  if (interval === '1D' || interval === '1H' || interval === '15m' || interval === '5m' || interval === '1m') {
    return points
  }

  const buckets = new Map()

  points.forEach((point) => {
    let bucketKey = point.time

    if (interval === '4H') {
      bucketKey = point.time - (point.time % (4 * 60 * 60))
    } else if (interval === '1W') {
      bucketKey = startOfWeek(point.time)
    } else if (interval === '1M') {
      bucketKey = startOfMonth(point.time)
    }

    const existing = buckets.get(bucketKey)
    if (!existing) {
      buckets.set(bucketKey, { ...point, time: bucketKey })
      return
    }

    existing.high = Math.max(existing.high, point.high)
    existing.low = Math.min(existing.low, point.low)
    existing.close = point.close
    existing.volume += point.volume
  })

  return [...buckets.values()].sort((left, right) => left.time - right.time)
}

function withinIndianMarketHours(timestampSeconds) {
  const date = new Date(timestampSeconds * 1000)
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
  const [hourText, minuteText] = formatter.format(date).split(':')
  const minutes = (Number(hourText) * 60) + Number(minuteText)
  return minutes >= (9 * 60 + 15) && minutes <= (15 * 60 + 30)
}

function applySessionFilter(points, interval) {
  if (!['1m', '5m', '15m', '1H', '4H'].includes(interval)) return points
  return points.filter((point) => withinIndianMarketHours(point.time))
}

export async function fetchBrokerStatus() {
  try {
    return await requestJson('/api/zerodha/status')
  } catch {
    return { connected: false, configured: false }
  }
}

export async function fetchMarketHistory(symbol, range = 'YTD', interval = '1D', options = {}) {
  const { allowExtendedHistory = false } = options
  try {
    const payload = await requestJson(
      `/api/market/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(resolveHistoryRequestRange(range, interval, allowExtendedHistory))}&interval=${encodeURIComponent(INTERVAL_TO_API[interval] || 'day')}`,
    )
    const points = aggregatePoints(applySessionFilter(normalizeHistory(payload, interval), interval), interval)
    if (!points.length) throw new Error('No history points returned')
    return { source: payload?.source || 'live', points, error: '' }
  } catch (error) {
    return {
      source: 'fallback',
      points: aggregatePoints(applySessionFilter(fallbackSeries(symbol, interval), interval), interval),
      error: error.message || 'History unavailable',
    }
  }
}

export async function fetchMarketQuote(symbol) {
  try {
    const payload = await requestJson(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`)
    return {
      price: Number(payload?.price || payload?.last_price || 0),
      changePercent: Number(payload?.changePercent || payload?.day_change_percent || 0),
      source: payload?.source || 'live',
    }
  } catch {
    const series = fallbackSeries(symbol, '1D', 4)
    const last = series[series.length - 1]
    const prev = series[series.length - 2] || last
    return {
      price: last.close,
      changePercent: ((last.close - prev.close) / prev.close) * 100,
      source: 'fallback',
    }
  }
}

export async function searchSymbols(query, limit = 12) {
  const term = query.trim()
  try {
    const payload = await requestJson(`/api/market/search?q=${encodeURIComponent(term)}&limit=${encodeURIComponent(limit)}`)
    if (Array.isArray(payload?.items) && payload.items.length) {
      return payload.items
    }
  } catch {
    // use fallback symbols
  }

  if (!term) return FALLBACK_SYMBOLS.slice(0, limit)
  return FALLBACK_SYMBOLS.filter((item) => `${item.symbol} ${item.name}`.toUpperCase().includes(term.toUpperCase())).slice(0, limit)
}
