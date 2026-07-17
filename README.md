# tenant-forge

POC de ORM multi-tenant cross-repo (estudo). Monorepo TypeScript com engine, CLI, SDK e editor visual.

## Layout

```
tenant-forge/
├── packages/
│   ├── core/   # @tenant-forge/core — engine (AST/DSL/query/adapters nas fases seguintes)
│   ├── cli/    # @tenant-forge/cli  — CLI estilo Prisma (stubs)
│   ├── sdk/    # @tenant-forge/sdk  — ORM client tipado (placeholder)
│   └── web/    # @tenant-forge/web  — editor React + Vite
├── tests/      # testes de monorepo / stubs de containers
├── docker-compose.yml
└── package.json
```

Gerenciador: **pnpm** workspaces.

## Pré-requisitos

- Node ≥ 20
- pnpm 10 (`corepack enable` ou instalação global)
- Docker (para testcontainers / `docker compose` nas fases de adapters)

## Comandos

```bash
pnpm install
pnpm build          # core → cli → sdk → web
pnpm test
pnpm lint
pnpm --filter @tenant-forge/web dev
pnpm --filter @tenant-forge/cli start
```

## Containers (stub Fase 1)

Imagens declaradas em `packages/core/src/containers.ts` e espelhadas em `docker-compose.yml`:

| Banco | Imagem |
|---|---|
| Postgres | `postgres:16-alpine` |
| MySQL | `mysql:8.4` |
| MongoDB | `mongo:7` |

`testcontainers` está em `@tenant-forge/core` para integração nas fases de adapters. Não é obrigatório subir os bancos nesta fase.

## Fronteira de pacotes

| Pacote | Papel |
|---|---|
| `core` | Engine: AST, DSL, queryBuilder, adapters |
| `sdk` | ORM client tipado fino sobre o engine |
| `cli` | Superfície CLI (`init` / `validate` / `generate` / `db *`) |
| `web` | Editor visual (round-trip com AST) |
