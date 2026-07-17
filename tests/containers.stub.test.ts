import { describe, expect, it } from 'vitest'
import { CONTAINER_IMAGES } from '../packages/core/src/containers.js'

describe('container stub', () => {
  it('declares images for the three target databases', () => {
    expect(CONTAINER_IMAGES.postgres).toContain('postgres')
    expect(CONTAINER_IMAGES.mysql).toContain('mysql')
    expect(CONTAINER_IMAGES.mongodb).toContain('mongo')
  })
})
