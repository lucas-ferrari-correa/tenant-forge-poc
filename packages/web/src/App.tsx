import { CORE_PACKAGE, coreVersion } from '@tenant-forge/core'

export function App() {
  return (
    <main className="app">
      <h1>tenant-forge</h1>
      <p>
        Visual editor scaffold — engine {CORE_PACKAGE}@{coreVersion()}
      </p>
    </main>
  )
}
