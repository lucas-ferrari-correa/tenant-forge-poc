# tenant-forge

POC de ORM multi-tenant cross-repo (estudo). Monorepo TypeScript com engine, CLI, SDK e editor visual.

## Layout

```
tenant-forge/
├── packages/
│   ├── core/   # @tenant-forge/core — engine (AST/DSL/query/adapters nas fases seguintes)
│   ├── cli/    # @tenant-forge/cli  — CLI estilo Prisma (init/validate/generate/db/tenancy)
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
| `cli` | Superfície CLI (`init` / `validate` / `generate` / `db *` / `tenancy migrate`) |
| `web` | Editor visual (round-trip com AST) |

## CLI (`tenant-forge`)

Casca fina sobre a API pública de `@tenant-forge/core` — a CLI resolve flags/ambiente e delega às primitivas do engine (`parseSchema`/`serializeSchema`, `pushSchema`, `pullSchema`, `migrateTenancy`). Parsing de argumentos via `node:util` `parseArgs` (sem dependência de framework).

```bash
pnpm --filter @tenant-forge/cli build
node packages/cli/dist/index.js <comando> [flags]
# ou, após publicar/linkar o bin:
tenant-forge <comando> [flags]
```

### Comandos

| Comando | O que faz | Toca DB |
|---|---|---|
| `init` | Escreve um schema DSL inicial (default `schema.tf`). `--force` sobrescreve. | não |
| `validate` | Parseia e valida o schema; erro reporta `linha:coluna`. | não |
| `generate` | Valida e informa que o codegen do ORM client é provido pelo `@tenant-forge/sdk`. | não |
| `db push` | Forward engineering: provisiona DB/schemas/tabelas a partir do AST. | sim |
| `db pull` | Introspecta o DB → schema DSL, inferindo o modelo de tenancy. | sim |
| `tenancy migrate` | Migra o DB entre modelos de tenancy, com movimentação de dados. | sim |

### Flags

| Flag | Env (fallback) | Uso |
|---|---|---|
| `--dialect <postgres\|mysql\|mongodb>` | `TENANT_FORGE_DIALECT` | dialeto alvo (comandos de DB) |
| `--url`, `--connection-string <uri>` | `DATABASE_URL` | string de conexão (comandos de DB) |
| `--schema <path>` | — | arquivo de schema (default `schema.tf`) |
| `--out <path>` | — | destino do schema em `db pull` (default stdout) |
| `--tenants <a,b,c>` | — | tenants (CSV) para `db push` / `tenancy migrate` |
| `--rls-session-var <name>` | — | GUC de RLS do Postgres |
| `--from <path>` | — | schema de origem explícito no `tenancy migrate` |
| `--no-drop-source` | — | preserva objetos de origem após a migração |
| `--assume-tenancy <model>` | — | modelo default quando o `pull`/`migrate` é ambíguo |
| `--entity-tenancy <Entity=model>` | — | dica de tenancy por entidade (repetível) |
| `--force` | — | sobrescreve arquivo existente no `init` |
| `--json` | — | emite o resultado estruturado do engine |
| `-h`, `--help` | — | ajuda |

### Exit codes

| Código | Significado |
|---|---|
| `0` | sucesso |
| `1` | erro de engine/runtime (ex.: falha de conexão) |
| `2` | erro de uso/validação (flags inválidas, comando desconhecido, `DslParseError`) |

Saída legível por default; `--json` emite o objeto de resultado do engine. Erros vão para `stderr`.
