/** The engine without Electron: `npm run engine`, for curl and for testing on its own. */

import { PORT } from './paths'
import { serve } from './server'
import { prepareEnvironment } from './startup'

prepareEnvironment()
serve().then(
  () => console.log(`Retronaut engine on http://127.0.0.1:${PORT}`),
  (e) => {
    console.error(`Couldn't start on port ${PORT}: ${(e as Error).message}`)
    process.exit(1)
  },
)
