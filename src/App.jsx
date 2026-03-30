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
  CrosshairMode,
  createSeriesMarkers,
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

function formatMaybePrice(value) {
  return Number.isFinite(value) ? formatPrice(value) : 'n/a'
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

function computeProgressiveSma(points, length) {
  const buffer = []
  return points.map((point) => {
    buffer.push(point.close)
    if (buffer.length > length) buffer.shift()
    return {
      time: point.time,
      value: Number(average(buffer).toFixed(2)),
    }
  }).filter((item) => Number.isFinite(item.value))
}

function latestSeriesValue(series) {
  if (!series.length) return null
  return series[series.length - 1]?.value ?? null
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

function computeMomentum(points, period = 20) {
  return points.map((point, index) => ({
    time: point.time,
    value: index >= period ? Number((point.close - points[index - period].close).toFixed(2)) : null,
  }))
}

function isPivotHigh(points, index, left = 5, right = 5) {
  if (index < left || index + right >= points.length) return false
  const pivot = points[index].high
  for (let offset = 1; offset <= left; offset += 1) {
    if (points[index - offset].high >= pivot) return false
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (points[index + offset].high > pivot) return false
  }
  return true
}

function isPivotLow(points, index, left = 5, right = 5) {
  if (index < left || index + right >= points.length) return false
  const pivot = points[index].low
  for (let offset = 1; offset <= left; offset += 1) {
    if (points[index - offset].low <= pivot) return false
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (points[index + offset].low < pivot) return false
  }
  return true
}

function detectBarioneDivergence(points, options = {}) {
  const {
    barsBack = 200,
    rsiPeriod = 14,
    momentumPeriod = 20,
    pivotLeft = 5,
    pivotRight = 5,
    useRsiFilter = true,
  } = options

  if (points.length < Math.max(barsBack, momentumPeriod + rsiPeriod + pivotLeft + pivotRight + 2)) {
    return { markers: [], priceSegments: [], rsiSegments: [] }
  }

  const rsiSeries = computeRsi(points, rsiPeriod)
  const rsiMap = new Map(rsiSeries.map((item) => [item.time, item.value]))
  const momentumSeries = computeMomentum(points, momentumPeriod)
  const momentumMap = new Map(momentumSeries.filter((item) => item.value != null).map((item) => [item.time, item.value]))

  const markers = []
  const priceSegments = []
  const rsiSegments = []
  let previousHighPivot = null
  let previousLowPivot = null

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const rsiValue = rsiMap.get(point.time)
    const momentumValue = momentumMap.get(point.time)

    if (isPivotHigh(points, index, pivotLeft, pivotRight) && Number.isFinite(rsiValue) && Number.isFinite(momentumValue)) {
      const currentHighPivot = {
        index,
        time: point.time,
        price: point.high,
        oscillator: rsiValue,
        momentum: momentumValue,
      }

      if (previousHighPivot && (currentHighPivot.index - previousHighPivot.index) <= barsBack) {
        const bearish = (
          currentHighPivot.price > previousHighPivot.price
          && currentHighPivot.oscillator < previousHighPivot.oscillator
          && currentHighPivot.momentum < previousHighPivot.momentum
          && (!useRsiFilter || currentHighPivot.oscillator > 70 || previousHighPivot.oscillator > 70)
        )

        if (bearish) {
          markers.push({
            time: currentHighPivot.time,
            position: 'aboveBar',
            shape: 'arrowDown',
            color: '#ef4444',
            text: 'Barione Bear',
          })
          priceSegments.push({
            color: '#ef4444',
            points: [
              { time: previousHighPivot.time, value: previousHighPivot.price },
              { time: currentHighPivot.time, value: currentHighPivot.price },
            ],
          })
          rsiSegments.push({
            color: '#ef4444',
            points: [
              { time: previousHighPivot.time, value: previousHighPivot.oscillator },
              { time: currentHighPivot.time, value: currentHighPivot.oscillator },
            ],
          })
        }
      }

      previousHighPivot = currentHighPivot
    }

    if (isPivotLow(points, index, pivotLeft, pivotRight) && Number.isFinite(rsiValue) && Number.isFinite(momentumValue)) {
      const currentLowPivot = {
        index,
        time: point.time,
        price: point.low,
        oscillator: rsiValue,
        momentum: momentumValue,
      }

      if (previousLowPivot && (currentLowPivot.index - previousLowPivot.index) <= barsBack) {
        const bullish = (
          currentLowPivot.price < previousLowPivot.price
          && currentLowPivot.oscillator > previousLowPivot.oscillator
          && currentLowPivot.momentum > previousLowPivot.momentum
          && (!useRsiFilter || currentLowPivot.oscillator < 30 || previousLowPivot.oscillator < 30)
        )

        if (bullish) {
          markers.push({
            time: currentLowPivot.time,
            position: 'belowBar',
            shape: 'arrowUp',
            color: '#22c55e',
            text: 'Barione Bull',
          })
          priceSegments.push({
            color: '#22c55e',
            points: [
              { time: previousLowPivot.time, value: previousLowPivot.price },
              { time: currentLowPivot.time, value: currentLowPivot.price },
            ],
          })
          rsiSegments.push({
            color: '#22c55e',
            points: [
              { time: previousLowPivot.time, value: previousLowPivot.oscillator },
              { time: currentLowPivot.time, value: currentLowPivot.oscillator },
            ],
          })
        }
      }

      previousLowPivot = currentLowPivot
    }
  }

  return { markers, priceSegments, rsiSegments }
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
  divergenceVisible,
}) {
  const chartRef = useRef(null)

  useEffect(() => {
    if (!chartRef.current) return undefined

    const sharedOptions = {
      layout: {
        background: { type: ColorType.Solid, color: '#0b111b' },
        textColor: '#e2e8f0',
        attributionLogo: false,
        panes: {
          separatorColor: 'rgba(148,163,184,0.28)',
          separatorHoverColor: 'rgba(148,163,184,0.36)',
          enableResize: false,
        },
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.07)' },
        horzLines: { color: 'rgba(148,163,184,0.07)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148,163,184,0.12)',
        scaleMargins: { top: 0.04, bottom: 0.04 },
        minimumWidth: 82,
      },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.12)',
        timeVisible: true,
        secondsVisible: false,
        ticksVisible: true,
        minimumHeight: 28,
        tickMarkMaxCharacterLength: 12,
      },
      localization: {
        priceFormatter: (value) => formatPrice(value),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(255,255,255,0.72)',
          width: 1,
          style: 2,
          labelBackgroundColor: '#f8fafc',
        },
        horzLine: {
          color: 'rgba(255,255,255,0.72)',
          width: 1,
          style: 2,
          labelBackgroundColor: '#f8fafc',
        },
      },
      handleScroll: true,
      handleScale: true,
    }

    const totalHeight = 460 + 120 + (rsiVisible ? 132 : 0) + (macdVisible ? 150 : 0) + 28

    const chart = createChart(chartRef.current, {
      ...sharedOptions,
      height: totalHeight,
    })

    const priceSeries = chart.addSeries(CandlestickSeries, {
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
    }, 0)
    const sma200Series = chart.addSeries(LineSeries, {
      color: '#ef4444',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0)
    const sma20Series = chart.addSeries(LineSeries, {
      color: '#22c55e',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0)
    const sma50Series = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    }, 0)
    const divergenceMarkers = createSeriesMarkers(priceSeries, [], {
      zOrder: 'aboveSeries',
    })

    const volumePaneIndex = 1
    let nextPaneIndex = 2
    const rsiPaneIndex = rsiVisible ? nextPaneIndex++ : null
    const macdPaneIndex = macdVisible ? nextPaneIndex++ : null

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: 'right',
    }, volumePaneIndex)

    const rsiSeries = rsiVisible
      ? chart.addSeries(LineSeries, {
        color: '#facc15',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, rsiPaneIndex)
      : null

    const macdLine = macdVisible
      ? chart.addSeries(LineSeries, {
        color: '#22c55e',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, macdPaneIndex)
      : null
    const signalLine = macdVisible
      ? chart.addSeries(LineSeries, {
        color: '#60a5fa',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, macdPaneIndex)
      : null
    const histogramSeries = macdVisible
      ? chart.addSeries(HistogramSeries, {
        priceLineVisible: false,
        lastValueVisible: false,
      }, macdPaneIndex)
      : null

    const candleData = points.map((point) => ({
      time: point.time,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
    }))

    priceSeries.setData(candleData)
    sma20Series.setData(computeSma(candleData, 20))
    sma50Series.setData(computeSma(candleData, 50))
    sma200Series.setData(computeProgressiveSma(candleData, 200))

    volumeSeries.setData(points.map((point) => ({
      time: point.time,
      value: point.volume,
      color: point.close >= point.open ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)',
    })))
    chart.priceScale('right', volumePaneIndex).applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.12, bottom: 0 },
      borderColor: 'rgba(148,163,184,0.12)',
      minimumWidth: 82,
    })

    const rsiData = computeRsi(candleData, 14)
    if (rsiSeries) {
      rsiSeries.setData(rsiData)
    }
    const macd = computeMacd(candleData)
    if (macdLine && signalLine && histogramSeries) {
      macdLine.setData(macd.macd)
      signalLine.setData(macd.signal)
      histogramSeries.setData(macd.histogram)
    }

    const latestRsi = rsiData
    const visibleRange = computeVisiblePriceRange(candleData, priceZoom)
    if (visibleRange) {
      chart.priceScale('right', 0).applyOptions({
        autoScale: false,
        mode: 0,
        scaleMargins: { top: 0.08, bottom: 0.08 },
        minimumWidth: 82,
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

    if (rsiSeries && rsiPaneIndex != null) {
      chart.priceScale('right', rsiPaneIndex).applyOptions({
        autoScale: false,
        mode: 0,
        scaleMargins: { top: 0.08, bottom: 0.08 },
        minimumWidth: 82,
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
    }

    if (macdPaneIndex != null) {
      chart.priceScale('right', macdPaneIndex).applyOptions({
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
        minimumWidth: 82,
      })
    }

    const divergence = detectBarioneDivergence(candleData)
    const priceDivergenceLines = []
    const rsiDivergenceLines = []
    if (divergenceVisible) {
      divergenceMarkers.setMarkers(divergence.markers)
      divergence.priceSegments.forEach((segment) => {
        const line = chart.addSeries(LineSeries, {
          color: segment.color,
          lineWidth: 2,
          lineStyle: 0,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        }, 0)
        line.setData(segment.points)
        priceDivergenceLines.push(line)
      })

      if (rsiSeries && rsiPaneIndex != null) {
        divergence.rsiSegments.forEach((segment) => {
          const line = chart.addSeries(LineSeries, {
            color: segment.color,
            lineWidth: 2,
            lineStyle: 0,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
          }, rsiPaneIndex)
          line.setData(segment.points)
          rsiDivergenceLines.push(line)
        })
      }
    } else {
      divergenceMarkers.setMarkers([])
    }

    chart.timeScale().fitContent()
    chart.panes()[0]?.setStretchFactor(5)
    chart.panes()[volumePaneIndex]?.setStretchFactor(2)
    if (rsiPaneIndex != null) chart.panes()[rsiPaneIndex]?.setStretchFactor(2)
    if (macdPaneIndex != null) chart.panes()[macdPaneIndex]?.setStretchFactor(2)

    const resizeCharts = () => {
      const width = chartRef.current?.clientWidth || 0
      if (width) chart.applyOptions({ width, height: totalHeight })
    }

    resizeCharts()
    window.addEventListener('resize', resizeCharts)

    return () => {
      window.removeEventListener('resize', resizeCharts)
      divergenceMarkers.detach()
      priceDivergenceLines.forEach((series) => chart.removeSeries(series))
      rsiDivergenceLines.forEach((series) => chart.removeSeries(series))
      chart.remove()
    }
  }, [chartType, divergenceVisible, macdVisible, points, priceZoom, rsiVisible])

  return (
    <div className="lw-layout">
      <div ref={chartRef} className="lw-pane lw-price-pane" />
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
  const [divergenceVisible, setDivergenceVisible] = useState(true)

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
  const sma20Value = useMemo(() => latestSeriesValue(computeSma(historyState.points, 20)), [historyState.points])
  const sma50Value = useMemo(() => latestSeriesValue(computeSma(historyState.points, 50)), [historyState.points])
  const sma200Value = useMemo(() => latestSeriesValue(computeProgressiveSma(historyState.points, 200)), [historyState.points])

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
            <span className="ma-chip ma20">SMA20 {formatMaybePrice(sma20Value)}</span>
            <span className="ma-chip ma50">SMA50 {formatMaybePrice(sma50Value)}</span>
            <span className="ma-chip ma200">SMA200 {formatMaybePrice(sma200Value)}</span>
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
              <button type="button" className={`chip subtle ${divergenceVisible ? 'selected' : ''}`} onClick={() => setDivergenceVisible((value) => !value)}>
                {divergenceVisible ? 'Hide Barione Div' : 'Show Barione Div'}
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
            <div className="pane-legend">
              <span className="pane-chip">Price</span>
              <span className="pane-chip">Volume</span>
              {rsiVisible ? <span className="pane-chip">RSI 14</span> : null}
              {macdVisible ? <span className="pane-chip">MACD</span> : null}
              <span className="pane-note">Shared time axis across all panes</span>
            </div>
            <LightweightChartWorkspace
              points={historyState.points}
              chartType={chartType}
              rsiVisible={rsiVisible}
              macdVisible={macdVisible}
              priceZoom={priceZoom}
              divergenceVisible={divergenceVisible}
            />
          </section>
        </main>
      </section>
    </div>
  )
}

export default App
