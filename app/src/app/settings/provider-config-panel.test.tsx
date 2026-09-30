// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

import type { MemoryProviderConfig } from '@/types/hermes'

const getMemoryProviderConfig = vi.fn()
const saveMemoryProviderConfig = vi.fn()

vi.mock('@/hermes', () => ({
  getMemoryProviderConfig: (provider: string) => getMemoryProviderConfig(provider),
  saveMemoryProviderConfig: (provider: string, values: unknown) => saveMemoryProviderConfig(provider, values)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function hindsightSchema(overrides: Partial<MemoryProviderConfig['fields'][number]>[] = []): MemoryProviderConfig {
  const fields: MemoryProviderConfig['fields'] = [
    {
      key: 'mode',
      label: 'Mode',
      kind: 'select',
      value: 'cloud',
      description: 'How Hermes connects to Hindsight.',
      placeholder: '',
      is_set: true,
      group: 'connection',
      inline: false,
      options: [
        { value: 'cloud', label: 'Cloud', description: 'Hindsight Cloud API (lightweight, just needs an API key)' },
        { value: 'local_external', label: 'Local External', description: 'Connect to an existing Hindsight instance' }
      ]
    },
    {
      key: 'api_key',
      label: 'API key',
      kind: 'secret',
      value: '',
      description: 'Used to authenticate with the Hindsight API.',
      placeholder: 'Enter Hindsight API key',
      is_set: false,
      group: 'connection',
      inline: false,
      options: []
    },
    {
      key: 'api_url',
      label: 'API URL',
      kind: 'text',
      value: 'https://api.hindsight.vectorize.io',
      description: '',
      placeholder: '',
      is_set: true,
      group: 'connection',
      inline: false,
      options: []
    },
    {
      key: 'bank_id',
      label: 'Bank ID',
      kind: 'text',
      value: 'hermes',
      description: '',
      placeholder: '',
      is_set: true,
      group: 'general',
      inline: false,
      options: []
    },
    {
      key: 'recall_budget',
      label: 'Recall budget',
      kind: 'select',
      value: 'mid',
      description: '',
      placeholder: '',
      is_set: true,
      group: 'general',
      inline: false,
      options: [
        { value: 'low', label: 'low', description: '' },
        { value: 'mid', label: 'mid', description: '' },
        { value: 'high', label: 'high', description: '' }
      ]
    }
  ]

  return {
    name: 'hindsight',
    label: 'Hindsight',
    docs_url: '',
    fields: fields.map((field, index) => ({ ...field, ...overrides[index] }))
  }
}

beforeEach(() => {
  getMemoryProviderConfig.mockResolvedValue(hindsightSchema())
  saveMemoryProviderConfig.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderPanel(provider = 'hindsight') {
  const { ProviderConfigPanel } = await import('./provider-config-panel')

  return render(<ProviderConfigPanel provider={provider} />)
}

describe('ProviderConfigPanel', () => {
  it('renders provider name', async () => {
    await renderPanel()
    expect(screen.getByText('Hindsight')).toBeInTheDocument()
  })

  it('renders all fields', async () => {
    await renderPanel()
    expect(screen.getByLabelText('Mode')).toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(screen.getByLabelText('API URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Bank ID')).toBeInTheDocument()
    expect(screen.getByLabelText('Recall budget')).toBeInTheDocument()
  })
})
