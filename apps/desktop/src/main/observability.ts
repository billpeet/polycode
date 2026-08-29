import {
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Histogram,
  type Gauge,
  type Span,
} from '@opentelemetry/api'
import { AsyncLocalStorage } from 'node:async_hooks'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'

export type TelemetryAttributes = Record<string, string | number | boolean>

export interface ObservabilityConfig {
  endpoint?: string
  headers?: Record<string, string>
  serviceVersion: string
  environment: string
  exportIntervalMs?: number
}

interface ObservabilityState {
  tracerProvider: NodeTracerProvider
  meterProvider: MeterProvider
  loggerProvider: LoggerProvider
  counters: Map<string, Counter>
  histograms: Map<string, Histogram>
  gauges: Map<string, Gauge>
}

let state: ObservabilityState | null = null
const activeSpans = new AsyncLocalStorage<Span>()

function signalUrl(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  const base = endpoint.replace(/\/+$/, '')
  return base.endsWith(`/v1/${signal}`) ? base : `${base}/v1/${signal}`
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {}

  return Object.fromEntries(
    value.split(',').flatMap((entry) => {
      const separator = entry.indexOf('=')
      if (separator <= 0) return []
      const key = entry.slice(0, separator).trim()
      const headerValue = entry.slice(separator + 1).trim()
      return key && headerValue ? [[key, headerValue]] : []
    })
  )
}

export function observabilityConfigFromEnv(serviceVersion: string): ObservabilityConfig {
  const packagedEndpoint = typeof __OTLP_ENDPOINT__ === 'undefined' ? '' : __OTLP_ENDPOINT__
  const packagedHeaders = typeof __OTLP_HEADERS__ === 'undefined' ? '' : __OTLP_HEADERS__
  return {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || packagedEndpoint.trim() || undefined,
    headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? packagedHeaders),
    serviceVersion,
    environment: process.env.OTEL_ENVIRONMENT?.trim() || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  }
}

export function initializeObservability(config: ObservabilityConfig): boolean {
  if (state || !config.endpoint) return false

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'polycode-desktop',
    [ATTR_SERVICE_NAMESPACE]: 'polycode',
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    'deployment.environment.name': config.environment,
    'process.type': 'electron-main',
  })
  const exporterOptions = { headers: config.headers }

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({
      ...exporterOptions,
      url: signalUrl(config.endpoint, 'traces'),
    }))],
  })
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        ...exporterOptions,
        url: signalUrl(config.endpoint, 'metrics'),
      }),
      exportIntervalMillis: config.exportIntervalMs ?? 30_000,
    })],
  })
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        ...exporterOptions,
        url: signalUrl(config.endpoint, 'logs'),
      }),
    })],
  })

  state = {
    tracerProvider,
    meterProvider,
    loggerProvider,
    counters: new Map(),
    histograms: new Map(),
    gauges: new Map(),
  }
  return true
}

export function recordGauge(
  name: string,
  value: number,
  unit: string,
  attributes: TelemetryAttributes = {}
): void {
  if (!state || !Number.isFinite(value) || value < 0) return
  let gauge = state.gauges.get(name)
  if (!gauge) {
    gauge = state.meterProvider.getMeter('polycode').createGauge(name, { unit })
    state.gauges.set(name, gauge)
  }
  gauge.record(value, attributes)
}

export function count(name: string, attributes: TelemetryAttributes = {}, value = 1): void {
  if (!state) return
  let counter = state.counters.get(name)
  if (!counter) {
    counter = state.meterProvider.getMeter('polycode').createCounter(name)
    state.counters.set(name, counter)
  }
  counter.add(value, attributes)
}

export function recordDuration(name: string, durationMs: number, attributes: TelemetryAttributes = {}): void {
  if (!state || !Number.isFinite(durationMs) || durationMs < 0) return
  let histogram = state.histograms.get(name)
  if (!histogram) {
    histogram = state.meterProvider.getMeter('polycode').createHistogram(name, { unit: 'ms' })
    state.histograms.set(name, histogram)
  }
  histogram.record(durationMs, attributes)
}

export async function withSpan<T>(
  name: string,
  attributes: TelemetryAttributes,
  operation: (span: Span | undefined) => T | Promise<T>
): Promise<T> {
  if (!state) return operation(undefined)
  const tracer = state.tracerProvider.getTracer('polycode')
  const parent = activeSpans.getStore()
  const parentContext = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT
  const span = tracer.startSpan(name, { attributes: attributes as Attributes }, parentContext)
  try {
    return await activeSpans.run(span, operation, span)
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR })
    if (error instanceof Error) span.recordException(error)
    throw error
  } finally {
    span.end()
  }
}

export function recordLog(
  severityText: string,
  body: string,
  attributes: TelemetryAttributes = {}
): void {
  const span = activeSpans.getStore()
  const activeContext = span ? trace.setSpan(ROOT_CONTEXT, span) : undefined
  state?.loggerProvider.getLogger('polycode').emit({ severityText, body, attributes, context: activeContext })
}

export async function shutdownObservability(): Promise<void> {
  const current = state
  state = null
  if (!current) return
  await Promise.allSettled([
    current.tracerProvider.shutdown(),
    current.meterProvider.shutdown(),
    current.loggerProvider.shutdown(),
  ])
}
