// Every test file gets its own data folder, so ledgers and workflows never touch real data.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.LOCAL_LINK_DATA = mkdtempSync(join(tmpdir(), 'local-link-test-'))
