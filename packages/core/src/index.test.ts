import { describe, expect, it } from 'vitest'
import { CORE_PACKAGE, coreVersion } from './index.js'

describe('core scaffold', () => {
  it('exports package identity', () => {
    expect(CORE_PACKAGE).toBe('@tenant-forge/core')
    expect(coreVersion()).toBe('0.0.0')
  })
})
