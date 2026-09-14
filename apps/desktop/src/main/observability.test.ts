import { afterEach, describe, expect, it, vi } from 'vitest'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node'
import {
  initializeObservability,
  observabilityConfigFromEnv,
  parseOtlpHeaders,
  shutdownObservability,
  currentTraceHeaders,
  remoteTraceContext,
  withSpan,
} from './observability'

afterEach(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS
  delete process.env.OTEL_ENVIRONMENT
  await shutdownObservability()
  vi.restoreAllMocks()
})

it('joins a remote handler and its work to the client trace', async () => {
  const spans: ReadableSpan[] = []
  vi.spyOn(OTLPTraceExporter.prototype, 'export').mockImplementation((batch, callback) => {
    spans.push(...batch)
    callback({ code: 0 })
  })
  initializeObservability({ endpoint: 'http://localhost:4318', serviceVersion: 'test', environment: 'test' })
  let traceparent: string | undefined
  await withSpan('ipc.client', {}, async () => { traceparent = currentTraceHeaders().traceparent })
  await withSpan('remote.rpc', { 'rpc.channel': 'threads:list' }, async () => {
    await withSpan('handler.work', {}, async () => {})
  }, remoteTraceContext(traceparent))
  await shutdownObservability()
  const client = spans.find((span) => span.name === 'ipc.client')!
  const server = spans.find((span) => span.name === 'remote.rpc')!
  const work = spans.find((span) => span.name === 'handler.work')!
  expect(server.spanContext().traceId).toBe(client.spanContext().traceId)
  expect(server.parentSpanContext?.spanId).toBe(client.spanContext().spanId)
  expect(work.parentSpanContext?.spanId).toBe(server.spanContext().spanId)
  expect(remoteTraceContext('00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01')).toBeUndefined()
  expect(remoteTraceContext('invalid')).toBeUndefined()
})

describe('observability configuration', () => {
  it('stays disabled when no OTLP endpoint is configured', () => {
    expect(initializeObservability(observabilityConfigFromEnv('1.2.3'))).toBe(false)
  })

  it('reads standard OTLP endpoint and headers', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://telemetry.example.test/otlp/'
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer token,x-scope=desktop'
    process.env.OTEL_ENVIRONMENT = 'test'

    expect(observabilityConfigFromEnv('1.2.3')).toEqual({
      endpoint: 'https://telemetry.example.test/otlp/',
      headers: { Authorization: 'Bearer token', 'x-scope': 'desktop' },
      serviceVersion: '1.2.3',
      environment: 'test',
    })
  })

  it('lets runtime environment override packaged release configuration', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-local=true'

    expect(observabilityConfigFromEnv('1.2.3')).toMatchObject({
      endpoint: 'http://localhost:4318',
      headers: { 'x-local': 'true' },
    })
  })

  it('ignores malformed headers and retains equals signs in values', () => {
    expect(parseOtlpHeaders('bad,authorization=Basic abc==,empty=')).toEqual({
      authorization: 'Basic abc==',
    })
  })
})

it('derives a stable anonymous installation identity from userData', () => {
  const first = observabilityConfigFromEnv('1', '/users/alice/polycode').serviceInstanceId
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(observabilityConfigFromEnv('2', '/users/alice/polycode').serviceInstanceId).toBe(first)
  expect(observabilityConfigFromEnv('1', '/users/bob/polycode').serviceInstanceId).not.toBe(first)
})
