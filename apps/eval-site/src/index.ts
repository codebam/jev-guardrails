/**
 * Cloudflare Worker entry point (module format).
 *
 * Deploy with `wrangler deploy`; tests import `createApp` from `./app.ts`
 * directly so they can inject a mocked upstream fetch.
 */
import { createApp } from './app.js'

const app = createApp()

export default app
export { createApp } from './app.js'
export type { AppOptions, EvalWorker } from './app.js'
