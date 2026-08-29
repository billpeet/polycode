import { afterEach, describe, expect, it } from 'vitest'
import {
  initializeObservability,
  observabilityConfigFromEnv,
  parseOtlpHeaders,
  shutdownObservability,
} from './observability'

afterEach(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS
  delete process.env.OTEL_ENVIRONMENT
  await shutdownObservability()
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
