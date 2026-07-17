/**
 * Testcontainers smoke helpers (Phase 1 stub).
 * Real Postgres / MySQL / Mongo modules arrive with adapters.
 */
export const CONTAINER_IMAGES = {
  postgres: 'postgres:16-alpine',
  mysql: 'mysql:8.4',
  mongodb: 'mongo:7',
} as const

export type SupportedDatabase = keyof typeof CONTAINER_IMAGES
