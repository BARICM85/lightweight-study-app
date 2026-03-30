import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChartCandlestick,
  Crosshair,
  Gauge,
  Minus,
  PencilLine,
  Search,
  Target,
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

const DRAW_TOOLS = [
  { label: 'Crosshair', icon: Crosshair },
  { label: 'Pick', icon: Target },
  { label: 'Trend', icon: PencilLine },
  { label: 'H Line', icon: Minus },
  { label: 'V Line', icon: Gauge },
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

function normalizeChartTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && 'year' in value && 'month' in value && 'day' in value) {
    return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000)
  }
  return null
}

function formatChartDate(rawTime) {
  const timestampSeconds = normalizeChartTime(rawTime)
  if (!Number.isFinite(timestampSeconds)) return 'n/a'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampSeconds * 1000))
}

function formatAxisDate(rawTime) {
  const timestampSeconds = normalizeChartTime(rawTime)
  if (!Number.isFinite(timestampSeconds)) return ''
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
  }).format(new Date(timestampSeconds * 1000))
}

function formatNoteTime(rawTime) {
  const timestampSeconds = normalizeChartTime(rawTime)
  if (!Number.isFinite(timestampSeconds)) return 'Note'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
  }).format(new Date(timestampSeconds * 1000))
}

function withOpacity(hex, alpha = 0.55) {
  const value = hex.replace('#', '')
  if (value.length !== 6) return hex
  const red = parseInt(value.slice(0, 2), 16)
  const green = parseInt(value.slice(2, 4), 16)
  const blue = parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function nextDrawingId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function pointLineDistance(target, start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return Math.hypot(target.x - start.x, target.y - start.y)
  }
  const t = Math.max(0, Math.min(1, (((target.x - start.x) * dx) + ((target.y - start.y) * dy)) / ((dx * dx) + (dy * dy))))
  const projection = { x: start.x + (t * dx), y: start.y + (t * dy) }
  return Math.hypot(target.x - projection.x, target.y - projection.y)
}

function findDrawingSelection({ time, price, points, trendLines, horizontalLines, verticalLines }) {
  if (!points.length || !Number.isFinite(time) || !Number.isFinite(price)) return null
  const minTime = points[0].time
  const maxTime = points[points.length - 1].time
  const lows = points.map((point) => point.low)
  const highs = points.map((point) => point.high)
  const minPrice = Math.min(...lows)
  const maxPrice = Math.max(...highs)
  const timeSpan = Math.max(1, maxTime - minTime)
  const priceSpan = Math.max(1, maxPrice - minPrice)
  const target = { x: (time - minTime) / timeSpan, y: (price - minPrice) / priceSpan }

  for (const line of trendLines) {
    const start = { x: (line.start.time - minTime) / timeSpan, y: (line.start.price - minPrice) / priceSpan }
    const end = { x: (line.end.time - minTime) / timeSpan, y: (line.end.price - minPrice) / priceSpan }
    if (pointLineDistance(target, start, end) <= 0.03) {
      return { type: 'trend', id: line.id }
    }
  }

  for (const line of horizontalLines) {
    if (Math.abs((price - line.price) / priceSpan) <= 0.015) {
      return { type: 'horizontal', id: line.id }
    }
  }

  for (const line of verticalLines) {
    if (Math.abs((time - line.time) / timeSpan) <= 0.015) {
      return { type: 'vertical', id: line.id }
    }
  }

  return null
}

function findNearestCandle(points, rawTime) {
  const targetTime = normalizeChartTime(rawTime)
  if (!points.length || !Number.isFinite(targetTime)) return null
  let nearest = points[0]
  let nearestDistance = Math.abs(points[0].time - targetTime)
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const distance = Math.abs(candidate.time - targetTime)
    if (distance < nearestDistance) {
      nearest = candidate
      nearestDistance = distance
    }
  }
  return nearest
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

function nearestSeriesValueAtTime(series, rawTime) {
  const targetTime = normalizeChartTime(rawTime)
  if (!series.length || !Number.isFinite(targetTime)) return null
  let nearest = series[0]
  let nearestDistance = Math.abs(series[0].time - targetTime)
  for (let index = 1; index < series.length; index += 1) {
    const candidate = series[index]
    const distance = Math.abs(candidate.time - targetTime)
    if (distance < nearestDistance) {
      nearest = candidate
      nearestDistance = distance
    }
  }
  return nearest?.value ?? null
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

function buildTopAxisTicks(points, logicalRange, tickCount = 5) {
  if (!points.length) return []
  const range = logicalRange ?? { from: 0, to: points.length - 1 }
  const span = Math.max(1, range.to - range.from)
  const indexes = Array.from({ length: tickCount }, (_, idx) => {
    const ratio = tickCount === 1 ? 0 : idx / (tickCount - 1)
    const rawIndex = range.from + (span * ratio)
    return Math.max(0, Math.min(points.length - 1, Math.round(rawIndex)))
  })
  return [...new Set(indexes)].map((index) => ({
    index,
    label: formatAxisDate(points[index]?.time),
    position: ((index - range.from) / span) * 100,
  }))
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
  crosshairWidth,
  divergenceVisible,
  onHoverChange,
  onAxisChange,
  selectedTool,
  trendLines,
  horizontalLines,
  verticalLines,
  selectedDrawing,
  onChartAction,
}) {
  const chartRef = useRef(null)
  const overlayRef = useRef(null)

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
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: 'rgba(74,222,128,0.09)' },
        horzLines: { color: 'rgba(74,222,128,0.09)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148,163,184,0.12)',
        scaleMargins: { top: 0.04, bottom: 0.04 },
        minimumWidth: 82,
      },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.12)',
        visible: true,
        timeVisible: true,
        secondsVisible: false,
        ticksVisible: true,
        minimumHeight: 22,
        tickMarkMaxCharacterLength: 12,
      },
      localization: {
        priceFormatter: (value) => formatPrice(value),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: 'rgba(255,255,255,0.72)',
          width: crosshairWidth,
          style: 2,
          labelVisible: true,
          labelBackgroundColor: '#f8fafc',
        },
        horzLine: {
          color: 'rgba(255,255,255,0.72)',
          width: crosshairWidth,
          style: 2,
          labelBackgroundColor: '#f8fafc',
        },
      },
      handleScroll: true,
      handleScale: true,
    }

    const totalHeight = 430 + 92 + (rsiVisible ? 104 : 0) + (macdVisible ? 116 : 0) + 24

    const chart = createChart(chartRef.current, {
      ...sharedOptions,
      height: totalHeight,
    })

    chart.applyOptions({
      crosshair: {
        vertLine: {
          labelVisible: true,
        },
      },
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
      crosshairMarkerVisible: false,
    }, 0)
    const sma20Series = chart.addSeries(LineSeries, {
      color: '#22c55e',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 0)
    const sma50Series = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, 0)
    const divergenceMarkers = createSeriesMarkers(priceSeries, [], {
      zOrder: 'aboveSeries',
    })
    const customDrawingSeries = []
    const customPriceLines = []

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
        crosshairMarkerVisible: false,
      }, rsiPaneIndex)
      : null

    const macdLine = macdVisible
      ? chart.addSeries(LineSeries, {
        color: '#22c55e',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }, macdPaneIndex)
      : null
    const signalLine = macdVisible
      ? chart.addSeries(LineSeries, {
        color: '#60a5fa',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
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

    trendLines.forEach((lineDef) => {
      const line = chart.addSeries(LineSeries, {
        color: lineDef.color,
        lineWidth: 2,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      }, 0)
      line.setData([
        { time: lineDef.start.time, value: lineDef.start.price },
        { time: lineDef.end.time, value: lineDef.end.price },
      ])
      customDrawingSeries.push(line)
    })

    horizontalLines.forEach((lineDef) => {
      const priceLine = priceSeries.createPriceLine({
        price: lineDef.price,
        color: lineDef.color,
        lineWidth: selectedDrawing?.type === 'horizontal' && selectedDrawing?.id === lineDef.id ? lineDef.width + 1 : lineDef.width,
        lineStyle: 2,
        axisLabelVisible: true,
        title: lineDef.label,
      })
      customPriceLines.push(priceLine)
    })

    const chartLow = Math.min(...candleData.map((point) => point.low))
    const chartHigh = Math.max(...candleData.map((point) => point.high))

    verticalLines.forEach((lineDef) => {
      const line = chart.addSeries(LineSeries, {
        color: lineDef.color,
        lineWidth: selectedDrawing?.type === 'vertical' && selectedDrawing?.id === lineDef.id ? lineDef.width + 1 : lineDef.width,
        lineStyle: 2,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      }, 0)
      line.setData([
        { time: lineDef.time, value: chartLow },
        { time: lineDef.time, value: chartHigh },
      ])
      customDrawingSeries.push(line)
    })

    const syncOverlayBoxes = () => {
      if (!overlayRef.current) return
      overlayRef.current.innerHTML = ''

      verticalLines.forEach((lineDef) => {
        const x = chart.timeScale().timeToCoordinate(lineDef.time)
        if (!Number.isFinite(x)) return
        const label = document.createElement('div')
        label.className = 'vline-box'
        label.style.left = `${x}px`
        label.style.top = '8px'
        label.style.borderColor = lineDef.color
        label.style.color = lineDef.color
        label.textContent = lineDef.label
        overlayRef.current.appendChild(label)
      })
    }

    chart.timeScale().fitContent()
    chart.panes()[0]?.setStretchFactor(5)
    chart.panes()[volumePaneIndex]?.setStretchFactor(2)
    if (rsiPaneIndex != null) chart.panes()[rsiPaneIndex]?.setStretchFactor(2)
    if (macdPaneIndex != null) chart.panes()[macdPaneIndex]?.setStretchFactor(2)

    const resizeCharts = () => {
      const width = chartRef.current?.clientWidth || 0
      if (width) chart.applyOptions({ width, height: totalHeight })
      syncOverlayBoxes()
    }

    const handleVisibleRangeChange = (logicalRange) => {
      onAxisChange?.(buildTopAxisTicks(points, logicalRange))
      syncOverlayBoxes()
    }

    const handleCrosshairMove = (param) => {
      if (!onHoverChange) return
      const hoveredData = param?.seriesData?.get(priceSeries)
      const hoveredTime = normalizeChartTime(param?.time)
      const fallbackCandle = hoveredData ? null : findNearestCandle(candleData, hoveredTime)
      if ((!hoveredData && !fallbackCandle) || hoveredTime == null) {
        onHoverChange(null)
        return
      }
      const candle = hoveredData ?? fallbackCandle
      onHoverChange({
        time: hoveredTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        x: param?.point?.x ?? null,
      })
    }

    chart.subscribeCrosshairMove(handleCrosshairMove)
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange)

    const handleClick = (param) => {
      if (!onChartAction || !selectedTool || !param?.point) return
      const time = normalizeChartTime(param.time)
      const hoveredCandle = param?.seriesData?.get(priceSeries)
      const fallbackCandle = findNearestCandle(candleData, time)
      const candle = hoveredCandle ?? fallbackCandle
      const rawPrice = priceSeries.coordinateToPrice(param.point.y)
      const price = Number.isFinite(rawPrice) ? rawPrice : candle?.close
      if (!Number.isFinite(time) || !Number.isFinite(price)) return
      onChartAction({
        tool: selectedTool,
        time,
        price,
        candle: candle ? {
          time: candle.time ?? time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        } : null,
      })
    }

    chart.subscribeClick(handleClick)
    chartRef.current.style.cursor = selectedTool === 'Crosshair' ? 'default' : 'crosshair'

    resizeCharts()
    window.addEventListener('resize', resizeCharts)
    handleVisibleRangeChange(chart.timeScale().getVisibleLogicalRange())
    syncOverlayBoxes()

    return () => {
      window.removeEventListener('resize', resizeCharts)
      chart.unsubscribeCrosshairMove(handleCrosshairMove)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange)
      chart.unsubscribeClick(handleClick)
      divergenceMarkers.detach()
      priceDivergenceLines.forEach((series) => chart.removeSeries(series))
      rsiDivergenceLines.forEach((series) => chart.removeSeries(series))
      customDrawingSeries.forEach((series) => chart.removeSeries(series))
      customPriceLines.forEach((line) => priceSeries.removePriceLine(line))
      if (chartRef.current) {
        chartRef.current.style.cursor = 'default'
      }
      chart.remove()
    }
  }, [chartType, crosshairWidth, divergenceVisible, horizontalLines, macdVisible, onAxisChange, onChartAction, onHoverChange, points, priceZoom, rsiVisible, selectedDrawing, selectedTool, trendLines, verticalLines])

  return (
    <div className="lw-layout">
      <div className="lw-chart-shell">
        <div ref={chartRef} className="lw-pane lw-price-pane" />
        <div ref={overlayRef} className="chart-overlay-layer" />
      </div>
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
  const [hoveredBar, setHoveredBar] = useState(null)
  const [topAxisTicks, setTopAxisTicks] = useState([])
  const [trendColor, setTrendColor] = useState('#22c55e')
  const [levelColor, setLevelColor] = useState('#f87171')
  const [verticalColor, setVerticalColor] = useState('#38bdf8')
  const [trendDraft, setTrendDraft] = useState(null)
  const [trendLines, setTrendLines] = useState([])
  const [horizontalLines, setHorizontalLines] = useState([])
  const [verticalLines, setVerticalLines] = useState([])
  const [selectedDrawing, setSelectedDrawing] = useState(null)
  const [drawWidth, setDrawWidth] = useState(2)
  const [drawSoftness, setDrawSoftness] = useState(0.55)
  const [crosshairWidth, setCrosshairWidth] = useState(1)
  const [pickedBar, setPickedBar] = useState(null)

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

  const handleChartAction = useCallback(({ tool, time, price, candle }) => {
    if (tool === 'Pick') {
      const selection = findDrawingSelection({
        time,
        price,
        points: historyState.points,
        trendLines,
        horizontalLines,
        verticalLines,
      })
      if (selection) {
        setSelectedDrawing(selection)
        return
      }
      setSelectedDrawing(null)
      if (candle) setPickedBar(candle)
      return
    }

    if (tool === 'Trend') {
      if (!trendDraft) {
        setSelectedDrawing(null)
        setTrendDraft({ time, price })
        return
      }
      setTrendLines((current) => [
        ...current,
        {
          id: nextDrawingId('trend'),
          start: trendDraft,
          end: { time, price },
          color: withOpacity(trendColor, drawSoftness),
          width: drawWidth,
        },
      ])
      setTrendDraft(null)
      return
    }

    if (tool === 'H Line') {
      setSelectedDrawing(null)
      setHorizontalLines((current) => [
        ...current,
        {
          id: nextDrawingId('horizontal'),
          price,
          color: withOpacity(levelColor, drawSoftness),
          width: drawWidth,
          label: `H ${formatPrice(price)}`,
        },
      ])
      return
    }

    if (tool === 'V Line') {
      setSelectedDrawing(null)
      setVerticalLines((current) => [
        ...current,
        {
          id: nextDrawingId('vertical'),
          time,
          color: withOpacity(verticalColor, drawSoftness),
          width: drawWidth,
          label: formatChartDate(time),
        },
      ])
      return
    }

  }, [drawSoftness, drawWidth, historyState.points, horizontalLines, levelColor, trendColor, trendDraft, trendLines, verticalColor, verticalLines])

  const lastBar = historyState.points[historyState.points.length - 1]
  const stats = useMemo(() => ({
    open: hoveredBar?.open ?? pickedBar?.open ?? lastBar?.open ?? quoteState.price ?? 0,
    high: hoveredBar?.high ?? pickedBar?.high ?? lastBar?.high ?? quoteState.price ?? 0,
    low: hoveredBar?.low ?? pickedBar?.low ?? lastBar?.low ?? quoteState.price ?? 0,
    close: hoveredBar?.close ?? pickedBar?.close ?? lastBar?.close ?? quoteState.price ?? 0,
    change: Number.isFinite(quoteState.changePercent) ? quoteState.changePercent : 0,
    time: hoveredBar?.time ?? pickedBar?.time ?? lastBar?.time ?? null,
  }), [hoveredBar, pickedBar, lastBar, quoteState])
  const sma20SeriesData = useMemo(() => computeSma(historyState.points, 20), [historyState.points])
  const sma50SeriesData = useMemo(() => computeSma(historyState.points, 50), [historyState.points])
  const sma200SeriesData = useMemo(() => computeProgressiveSma(historyState.points, 200), [historyState.points])
  const activeSeriesTime = hoveredBar?.time ?? pickedBar?.time ?? lastBar?.time ?? null
  const sma20Value = useMemo(() => nearestSeriesValueAtTime(sma20SeriesData, activeSeriesTime), [activeSeriesTime, sma20SeriesData])
  const sma50Value = useMemo(() => nearestSeriesValueAtTime(sma50SeriesData, activeSeriesTime), [activeSeriesTime, sma50SeriesData])
  const sma200Value = useMemo(() => nearestSeriesValueAtTime(sma200SeriesData, activeSeriesTime), [activeSeriesTime, sma200SeriesData])
  const resolvedTopAxisTicks = useMemo(
    () => (topAxisTicks.length ? topAxisTicks : buildTopAxisTicks(historyState.points, { from: 0, to: historyState.points.length - 1 })),
    [historyState.points, topAxisTicks],
  )
  const cursorAxisStyle = useMemo(() => {
    if (!Number.isFinite(hoveredBar?.x)) return null
    return {
      left: `clamp(56px, ${hoveredBar.x}px, calc(100% - 56px))`,
    }
  }, [hoveredBar])
  const toolHint = useMemo(() => {
    if (selectedTool === 'Trend' && trendDraft) {
      return 'Trend start locked. Click a second candle to complete the line.'
    }
    if (selectedTool === 'Trend') return 'Trend mode: click one candle, then click another candle.'
    if (selectedTool === 'H Line') return 'Horizontal line mode: click once to place a price line.'
    if (selectedTool === 'V Line') return 'Vertical line mode: click once to place a date/time line.'
    if (selectedTool === 'Pick') return 'Pick mode: click a candle to pin its OHLC values above.'
    return 'Crosshair mode: move over candles to inspect price and date.'
  }, [selectedTool, trendDraft])

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

            <div className="symbol-stack">
              <div className="symbol-strip">
                <strong>{selectedSymbol.symbol}</strong>
                <span>{selectedSymbol.name}</span>
                <span>{formatPrice(quoteState.price)} INR</span>
                <span className={stats.change >= 0 ? 'up' : 'down'}>{formatPercent(stats.change)}</span>
              </div>
              <div className="tool-inline-bar tool-inline-right">
                <div className="tool-inline-group">
                  {DRAW_TOOLS.map((tool) => {
                    const Icon = tool.icon
                    return (
                      <button
                        key={tool.label}
                        type="button"
                        className={`tool-inline-btn ${selectedTool === tool.label ? 'active' : ''}`}
                        onClick={() => setSelectedTool(tool.label)}
                        title={tool.label}
                      >
                        <Icon size={14} />
                        <span>{tool.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="tool-inline-bar tool-inline-right tool-inline-secondary">
                <div className="tool-inline-group tool-inline-colors">
                  <label className="tool-color">
                    <span>Trend</span>
                    <input type="color" value={trendColor} onChange={(event) => setTrendColor(event.target.value)} />
                  </label>
                  <label className="tool-color">
                    <span>H Line</span>
                    <input type="color" value={levelColor} onChange={(event) => setLevelColor(event.target.value)} />
                  </label>
                  <label className="tool-color">
                    <span>V Line</span>
                    <input type="color" value={verticalColor} onChange={(event) => setVerticalColor(event.target.value)} />
                  </label>
                  <label className="tool-slider">
                    <span>Width</span>
                    <input type="range" min="1" max="5" step="1" value={drawWidth} onChange={(event) => setDrawWidth(Number(event.target.value))} />
                  </label>
                  <label className="tool-slider">
                    <span>Soft</span>
                    <input type="range" min="0.2" max="1" step="0.05" value={drawSoftness} onChange={(event) => setDrawSoftness(Number(event.target.value))} />
                  </label>
                  <label className="tool-slider">
                    <span>Cursor</span>
                    <input type="range" min="1" max="4" step="1" value={crosshairWidth} onChange={(event) => setCrosshairWidth(Number(event.target.value))} />
                  </label>
                </div>
                <div className="tool-inline-group">
                  {selectedDrawing ? (
                    <button
                      type="button"
                      className="tool-inline-btn"
                      onClick={() => {
                        if (selectedDrawing.type === 'trend') {
                          setTrendLines((current) => current.filter((item) => item.id !== selectedDrawing.id))
                        }
                        if (selectedDrawing.type === 'horizontal') {
                          setHorizontalLines((current) => current.filter((item) => item.id !== selectedDrawing.id))
                        }
                        if (selectedDrawing.type === 'vertical') {
                          setVerticalLines((current) => current.filter((item) => item.id !== selectedDrawing.id))
                        }
                        setSelectedDrawing(null)
                      }}
                    >
                      Delete selected
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="tool-inline-btn"
                    onClick={() => {
                      setTrendDraft(null)
                      setTrendLines([])
                      setHorizontalLines([])
                      setVerticalLines([])
                      setSelectedDrawing(null)
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="control-row">
            <div className="chip-row">
              <label className="interval-select-wrap">
                <span>TF</span>
                <select value={interval} onChange={(event) => setInterval(event.target.value)} className="interval-select">
                  {INTERVAL_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
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
              <button type="button" className="chip subtle" onClick={() => setPriceZoom(1)}>
                Reset Y
              </button>
            </div>
          </div>

          <section className="chart-card">
            <div className="chart-overlay-header">
              <div className="stats-strip floating-stats">
                <span className="symbol-label">{selectedSymbol.symbol}</span>
                <span className="date-chip">{formatChartDate(stats.time)}</span>
                <span>O {formatPrice(stats.open)}</span>
                <span>H {formatPrice(stats.high)}</span>
                <span>L {formatPrice(stats.low)}</span>
                <span>C {formatPrice(stats.close)}</span>
                <span className={stats.change >= 0 ? 'up' : 'down'}>{formatPercent(stats.change)}</span>
              </div>
              <div className="stats-strip floating-ma-row">
                <span className="ma-inline ma20">S20 {formatMaybePrice(sma20Value)}</span>
                <span className="ma-inline ma50">S50 {formatMaybePrice(sma50Value)}</span>
                <span className="ma-inline ma200">S200 {formatMaybePrice(sma200Value)}</span>
              </div>
              <div className="pane-legend floating">
                <span className="pane-chip">Price</span>
                <span className="pane-chip">Volume</span>
                {rsiVisible ? <span className="pane-chip">RSI 14</span> : null}
                {macdVisible ? <span className="pane-chip">MACD</span> : null}
              </div>
              {cursorAxisStyle ? (
                <div className="cursor-date-pill chart-cursor-pill" style={cursorAxisStyle}>
                  {formatChartDate(stats.time)}
                </div>
              ) : null}
            </div>
            <LightweightChartWorkspace
              points={historyState.points}
              chartType={chartType}
              rsiVisible={rsiVisible}
              macdVisible={macdVisible}
              priceZoom={priceZoom}
              crosshairWidth={crosshairWidth}
              divergenceVisible={divergenceVisible}
              onHoverChange={setHoveredBar}
              onAxisChange={setTopAxisTicks}
              selectedTool={selectedTool}
              trendLines={trendLines}
              horizontalLines={horizontalLines}
              verticalLines={verticalLines}
              selectedDrawing={selectedDrawing}
              onChartAction={handleChartAction}
            />
          </section>
        </main>
      </section>
    </div>
  )
}

export default App
