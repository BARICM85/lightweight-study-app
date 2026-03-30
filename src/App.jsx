import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  ChartCandlestick,
  Crosshair,
  Gauge,
  PencilLine,
  Search,
  Shapes,
  TrendingUp,
  X,
} from 'lucide-react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
} from 'lightweight-charts'
import {
  DEFAULT_SYMBOL,
  INTERVAL_OPTIONS,
  RANGE_OPTIONS,
  fetchBrokerStatus,
  fetchMarketHistory,
  fetchMarketQuote,
  searchSymbols,
} from './lib/marketApi'

const TOOLS = [
  { label: 'Crosshair', icon: Crosshair },
  { label: 'Trend', icon: PencilLine },
  { label: 'Ray', icon: TrendingUp },
  { label: 'Horizontal', icon: Shapes },
  { label: 'Price', icon: Gauge },
  { label: 'Note', icon: Bell },
]

function formatPrice(value) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0)
}

function formatPercent(value) {
  const safe = Number.isFinite(value) ? value : 0
  return `${safe >= 0 ? '+' : ''}${safe.toFixed(2)}%`
}

function sourceLabel(source) {
  if (source === 'zerodha') return 'Zerodha live'
  if (source === 'yahoo') return 'Last trading day'
  if (source === 'fallback') return 'Fallback feed'
  return 'Live market'
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function computeSma(points, length) {
  const buffer = []
  return points.map((point) => {
    buffer.push(point.close)
    if (buffer.length > length) buffer.shift()
    return {
      time: point.time,
      value: buffer.length === length ? Number(average(buffer).toFixed(2)) : null,
    }
  }).filter((item) => item.value !== null)
}

function computeRsi(points, period = 14) {
  if (points.length < period + 1) return []
  const output = []
  let gains = 0
  let losses = 0

  for (let index = 1; index <= period; index += 1) {
    const change = points[index].close - points[index - 1].close
    if (change >= 0) gains += change
    else losses += Math.abs(change)
  }

  let averageGain = gains / period
  let averageLoss = losses / period

  for (let index = period + 1; index < points.length; index += 1) {
    const change = points[index].close - points[index - 1].close
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? Math.abs(change) : 0
    averageGain = ((averageGain * (period - 1)) + gain) / period
    averageLoss = ((averageLoss * (period - 1)) + loss) / period
    const relativeStrength = averageLoss === 0 ? 100 : averageGain / averageLoss
    const value = averageLoss === 0 ? 100 : 100 - (100 / (1 + relativeStrength))
    output.push({ time: points[index].time, value: Number(value.toFixed(2)) })
  }

  return output
}

function computeEmaSeries(values, period) {
  const smoothing = 2 / (period + 1)
  const result = []
  let ema = null

  values.forEach((item, index) => {
    if (index < period - 1) {
      result.push(null)
      return
    }

    if (index === period - 1) {
      const seed = average(values.slice(0, period).map((value) => value.close))
      ema = seed
      result.push(seed)
      return
    }

    ema = ((item.close - ema) * smoothing) + ema
    result.push(ema)
  })

  return result
}

function computeMacd(points, fast = 12, slow = 26, signalPeriod = 9) {
  if (points.length < slow + signalPeriod) return { macd: [], signal: [], histogram: [] }

  const fastEma = computeEmaSeries(points, fast)
  const slowEma = computeEmaSeries(points, slow)
  const macdRaw = points.map((point, index) => {
    const fastValue = fastEma[index]
    const slowValue = slowEma[index]
    if (fastValue == null || slowValue == null) return null
    return { time: point.time, close: fastValue - slowValue }
  }).filter(Boolean)

  const signalValues = computeEmaSeries(macdRaw, signalPeriod)
  const macd = []
  const signal = []
  const histogram = []

  macdRaw.forEach((item, index) => {
    const signalValue = signalValues[index]
    if (signalValue == null) return
    const histogramValue = item.close - signalValue
    macd.push({ time: item.time, value: Number(item.close.toFixed(2)) })
    signal.push({ time: item.time, value: Number(signalValue.toFixed(2)) })
    histogram.push({
      time: item.time,
      value: Number(histogramValue.toFixed(2)),
      color: histogramValue >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)',
    })
  })

  return { macd, signal, histogram }
}

function computeVisiblePriceRange(points, zoomFactor = 1) {
  if (!points.length) return null
  const lows = points.map((point) => point.low).filter((value) => Number.isFinite(value) && value > 0)
  const highs = points.map((point) => point.high).filter((value) => Number.isFinite(value) && value > 0)
  if (!lows.length || !highs.length) return null
  const min = Math.min(...lows)
  const max = Math.max(...highs)
  const span = Math.max(max - min, max * 0.015)
  const midpoint = (max + min) / 2
  const scaledSpan = span / Math.max(0.5, zoomFactor)
  const padding = scaledSpan * 0.08
  return {
    from: Number(Math.max(0.01, midpoint - (scaledSpan / 2) - padding).toFixed(2)),
    to: Number((midpoint + (scaledSpan / 2) + padding).toFixed(2)),
  }
}

function LightweightChartWorkspace({
  points,
  chartType,
  macdVisible,
  rsiVisible,
  priceZoom,
}) {
  const priceRef = useRef(null)
  const volumeRef = useRef(null)
  const rsiRef = useRef(null)
  const macdRef = useRef(null)

  useEffect(() => {
    if (!priceRef.current || !volumeRef.current || !rsiRef.current || !macdRef.current) return undefined

    const sharedOptions = {
      layout: {
        background: { type: ColorType.Solid, color: '#0b111b' },
        textColor: '#e2e8f0',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.07)' },
        horzLines: { color: 'rgba(148,163,184,0.07)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148,163,184,0.12)',
        scaleMargins: { top: 0.04, bottom: 0.04 },
      },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.12)',
        timeVisible: true,
        secondsVisible: false,
      },
      localization: {
        priceFormatter: (value) => formatPrice(value),
      },
      crosshair: {
        vertLine: { color: 'rgba(226,232,240,0.18)', labelBackgroundColor: '#e2e8f0' },
        horzLine: { color: 'rgba(226,232,240,0.18)', labelBackgroundColor: '#e2e8f0' },
      },
      handleScroll: true,
      handleScale: true,
    }

    const priceChart = createChart(priceRef.current, {
      ...sharedOptions,
      height: 460,
      timeScale: {
        ...sharedOptions.timeScale,
        visible: false,
      },
    })
    const volumeChart = createChart(volumeRef.current, {
      ...sharedOptions,
      height: 120,
      timeScale: {
        ...sharedOptions.timeScale,
        visible: false,
      },
    })
    const rsiChart = createChart(rsiRef.current, {
      ...sharedOptions,
      height: rsiVisible ? 132 : 0,
      timeScale: {
        ...sharedOptions.timeScale,
        visible: false,
      },
    })
    const macdChart = createChart(macdRef.current, {
      ...sharedOptions,
      height: macdVisible ? 150 : 0,
      timeScale: {
        ...sharedOptions.timeScale,
        visible: true,
      },
    })

    const priceSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: '#17c964',
      downColor: '#ef4444',
      borderVisible: chartType !== 'stroke',
      wickUpColor: '#17c964',
      wickDownColor: '#ef4444',
      borderUpColor: '#17c964',
      borderDownColor: '#ef4444',
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: '#9ca3af',
    })

    const volumeSeries = volumeChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: 'right',
    })

    const rsiSeries = rsiChart.addSeries(LineSeries, {
      color: '#facc15',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })

    const macdLine = macdChart.addSeries(LineSeries, {
      color: '#22c55e',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    const signalLine = macdChart.addSeries(LineSeries, {
      color: '#60a5fa',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    const histogramSeries = macdChart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
    })

    const candleData = points.map((point) => ({
      time: point.time,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
    }))

    priceSeries.setData(candleData)

    volumeSeries.setData(points.map((point) => ({
      time: point.time,
      value: point.volume,
      color: point.close >= point.open ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)',
    })))
    volumeChart.priceScale('right').applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.12, bottom: 0 },
      borderColor: 'rgba(148,163,184,0.12)',
    })

    rsiSeries.setData(computeRsi(candleData, 14))
    const macd = computeMacd(candleData)
    macdLine.setData(macd.macd)
    signalLine.setData(macd.signal)
    histogramSeries.setData(macd.histogram)

    const latestRsi = computeRsi(candleData, 14)
    const visibleRange = computeVisiblePriceRange(candleData, priceZoom)
    if (visibleRange) {
      priceChart.priceScale('right').applyOptions({
        autoScale: false,
        mode: 0,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      })
      priceSeries.applyOptions({
        autoscaleInfoProvider: () => ({
          priceRange: {
            minValue: visibleRange.from,
            maxValue: visibleRange.to,
          },
        }),
      })
    }

    rsiChart.priceScale('right').applyOptions({
      autoScale: false,
      mode: 0,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    })
    rsiSeries.createPriceLine({
      price: 70,
      color: 'rgba(239,68,68,0.55)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: '',
    })
    rsiSeries.createPriceLine({
      price: 30,
      color: 'rgba(34,197,94,0.55)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: '',
    })
    if (latestRsi.length > 0) {
      rsiSeries.createPriceLine({
        price: latestRsi[latestRsi.length - 1].value,
        color: '#facc15',
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title: 'RSI 14',
      })
    }

    const syncRange = (range) => {
      if (!range) return
      volumeChart.timeScale().setVisibleLogicalRange(range)
      rsiChart.timeScale().setVisibleLogicalRange(range)
      macdChart.timeScale().setVisibleLogicalRange(range)
    }

    priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncRange)
    priceChart.timeScale().fitContent()

    const initialRange = priceChart.timeScale().getVisibleLogicalRange()
    if (initialRange) {
      syncRange(initialRange)
    }

    const resizeCharts = () => {
      const priceWidth = priceRef.current?.clientWidth || 0
      const volumeWidth = volumeRef.current?.clientWidth || 0
      const rsiWidth = rsiRef.current?.clientWidth || 0
      const macdWidth = macdRef.current?.clientWidth || 0
      if (priceWidth) priceChart.applyOptions({ width: priceWidth })
      if (volumeWidth) volumeChart.applyOptions({ width: volumeWidth })
      if (rsiWidth) rsiChart.applyOptions({ width: rsiWidth, height: rsiVisible ? 132 : 0 })
      if (macdWidth) macdChart.applyOptions({ width: macdWidth, height: macdVisible ? 150 : 0 })
      const syncedRange = priceChart.timeScale().getVisibleLogicalRange()
      if (syncedRange) {
        syncRange(syncedRange)
      }
    }

    resizeCharts()
    window.addEventListener('resize', resizeCharts)

    return () => {
      window.removeEventListener('resize', resizeCharts)
      priceChart.remove()
      volumeChart.remove()
      rsiChart.remove()
      macdChart.remove()
    }
  }, [chartType, macdVisible, points, priceZoom, rsiVisible])

  return (
    <div className="lw-layout">
      <div ref={priceRef} className="lw-pane lw-price-pane" />
      <div ref={volumeRef} className="lw-pane lw-volume-pane" />
      {rsiVisible ? <div ref={rsiRef} className="lw-pane lw-rsi-pane" /> : null}
      {macdVisible ? <div ref={macdRef} className="lw-pane lw-macd-pane" /> : null}
    </div>
  )
}

function App() {
  const [selectedSymbol, setSelectedSymbol] = useState(DEFAULT_SYMBOL)
  const [searchValue, setSearchValue] = useState(DEFAULT_SYMBOL.symbol)
  const [suggestions, setSuggestions] = useState([DEFAULT_SYMBOL])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [interval, setInterval] = useState('1D')
  const [range, setRange] = useState('YTD')
  const [chartType, setChartType] = useState('stroke')
  const [selectedTool, setSelectedTool] = useState('Crosshair')
  const [brokerStatus, setBrokerStatus] = useState({ connected: false, configured: false })
  const [historyState, setHistoryState] = useState({ source: 'loading', points: [], error: '' })
  const [quoteState, setQuoteState] = useState({ price: 0, changePercent: 0, source: 'loading' })
  const [rsiVisible, setRsiVisible] = useState(true)
  const [macdVisible, setMacdVisible] = useState(true)
  const [priceZoom, setPriceZoom] = useState(1)

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(async () => {
      const results = await searchSymbols(searchValue, 16)
      if (active) setSuggestions(results)
    }, 180)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [searchValue])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setHistoryState((current) => ({ ...current, error: '' }))
      const [history, quote, broker] = await Promise.all([
        fetchMarketHistory(selectedSymbol.symbol, range, interval),
        fetchMarketQuote(selectedSymbol.symbol),
        fetchBrokerStatus(),
      ])

      if (cancelled) return
      setHistoryState(history)
      setQuoteState(quote)
      setBrokerStatus(broker)
    }

    load()

    return () => {
      cancelled = true
    }
  }, [interval, range, selectedSymbol.symbol])

  const lastBar = historyState.points[historyState.points.length - 1]
  const stats = useMemo(() => ({
    open: lastBar?.open ?? quoteState.price ?? 0,
    high: lastBar?.high ?? quoteState.price ?? 0,
    low: lastBar?.low ?? quoteState.price ?? 0,
    close: lastBar?.close ?? quoteState.price ?? 0,
    change: Number.isFinite(quoteState.changePercent) ? quoteState.changePercent : 0,
  }), [lastBar, quoteState])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <ChartCandlestick size={18} />
          </div>
          <div>
            <p className="eyebrow">Separate Lightweight Prototype</p>
            <h1>Fast Stock Chart Workspace</h1>
          </div>
        </div>
        <div className="header-status">
          <span className={`badge ${brokerStatus.connected ? 'good' : 'warn'}`}>
            {brokerStatus.connected ? 'ZERODHA CONNECTED' : 'ZERODHA STANDBY'}
          </span>
          <span className="badge neutral">{sourceLabel(historyState.source)}</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-tools">
          {TOOLS.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.label}
                type="button"
                className={`tool-btn ${selectedTool === tool.label ? 'active' : ''}`}
                onClick={() => setSelectedTool(tool.label)}
                title={tool.label}
              >
                <Icon size={18} />
              </button>
            )
          })}
        </aside>

        <main className="chart-panel">
          <div className="top-bar">
            <div className="search-box-wrap">
              <div className="search-box">
                <Search size={16} />
                <input
                  value={searchValue}
                  onFocus={() => setShowSuggestions(true)}
                  onChange={(event) => setSearchValue(event.target.value.toUpperCase())}
                  placeholder="Search NSE stocks and indices"
                />
              </div>
              {showSuggestions ? (
                <div className="suggestion-panel">
                  <div className="suggestion-header">
                    <span>Choose symbol</span>
                    <button type="button" className="close-btn" onClick={() => setShowSuggestions(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  {suggestions.map((item) => (
                    <button
                      key={`${item.exchange || 'NSE'}:${item.symbol}`}
                      type="button"
                      className="suggestion-item"
                      onClick={() => {
                        setSelectedSymbol(item)
                        setSearchValue(item.symbol)
                        setShowSuggestions(false)
                      }}
                    >
                      <strong>{item.symbol}</strong>
                      <span>{item.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="symbol-strip">
              <strong>{selectedSymbol.symbol}</strong>
              <span>{selectedSymbol.name}</span>
              <span>{formatPrice(quoteState.price)} INR</span>
              <span className={stats.change >= 0 ? 'up' : 'down'}>{formatPercent(stats.change)}</span>
            </div>
          </div>

          <div className="stats-strip">
            <span className="symbol-label">{selectedSymbol.symbol}</span>
            <span>O {formatPrice(stats.open)}</span>
            <span>H {formatPrice(stats.high)}</span>
            <span>L {formatPrice(stats.low)}</span>
            <span>C {formatPrice(stats.close)}</span>
            <span className={stats.change >= 0 ? 'up' : 'down'}>{formatPercent(stats.change)}</span>
            {historyState.error ? <span className="error-text">{historyState.error}</span> : null}
          </div>

          <div className="control-row">
            <div className="chip-row">
              {INTERVAL_OPTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`chip ${interval === item ? 'selected' : ''}`}
                  onClick={() => setInterval(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="chip-row">
              {RANGE_OPTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`chip subtle ${range === item ? 'selected' : ''}`}
                  onClick={() => setRange(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <div className="control-row">
            <div className="chip-row">
              {[
                { label: 'Candles', value: 'stroke' },
                { label: 'Solid', value: 'solid' },
                { label: 'OHLC', value: 'ohlc' },
              ].map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`chip subtle ${chartType === item.value ? 'selected' : ''}`}
                  onClick={() => setChartType(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="chip-row">
              <button type="button" className={`chip subtle ${rsiVisible ? 'selected' : ''}`} onClick={() => setRsiVisible((value) => !value)}>
                {rsiVisible ? 'Hide RSI' : 'Show RSI'}
              </button>
              <button type="button" className={`chip subtle ${macdVisible ? 'selected' : ''}`} onClick={() => setMacdVisible((value) => !value)}>
                {macdVisible ? 'Hide MACD' : 'Show MACD'}
              </button>
              <button type="button" className="chip subtle" onClick={() => setPriceZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))}>
                Y+
              </button>
              <button type="button" className="chip subtle" onClick={() => setPriceZoom((value) => Math.max(0.75, Number((value - 0.25).toFixed(2))))}>
                Y-
              </button>
              <button type="button" className="chip subtle" onClick={() => setPriceZoom(1)}>
                Reset Y
              </button>
            </div>
          </div>

          <section className="chart-card">
            <LightweightChartWorkspace
              points={historyState.points}
              chartType={chartType}
              rsiVisible={rsiVisible}
              macdVisible={macdVisible}
              priceZoom={priceZoom}
            />
          </section>
        </main>
      </section>
    </div>
  )
}

export default App
