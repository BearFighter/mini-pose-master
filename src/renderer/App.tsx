// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'

const STEPS = ['Import', 'Rig', 'Pose', 'Hands', 'Weapons', 'Export'] as const
type Step = (typeof STEPS)[number]

interface StatusInfo {
  version: string
  platform: string
}

export function App() {
  const [step, setStep] = useState<Step>('Import')
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  useEffect(() => {
    window.mpm.app
      .info()
      .then((info) => setStatus({ version: info.version, platform: info.platform }))
      .catch((err: unknown) => setStatusError(String(err)))
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        {STEPS.map((name) => (
          <button
            key={name}
            className={name === step ? 'step-button active' : 'step-button'}
            onClick={() => setStep(name)}
          >
            {name}
          </button>
        ))}
      </aside>

      <main className="viewport">
        <Canvas camera={{ position: [2, 1.5, 3], fov: 45 }}>
          <gridHelper args={[10, 10]} />
          <OrbitControls />
        </Canvas>
      </main>

      <section className="panel">
        <h2>{step}</h2>
        <p>Coming soon</p>
      </section>

      <footer className="status-bar">
        {statusError
          ? `Status unavailable: ${statusError}`
          : status
            ? `Mini Pose Master v${status.version} · ${status.platform}`
            : 'Loading...'}
      </footer>
    </div>
  )
}
