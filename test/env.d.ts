import type { Env as WorkerEnv } from '../src/types'

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      // Only the default export: the Durable Object classes implement the
      // DurableObject interface rather than extending the branded base class,
      // which Cloudflare.Exports would require of every listed export.
      mainModule: { default: typeof import('../src/index').default }
    }
  }
}
