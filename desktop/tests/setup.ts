// Every test file gets its own data folder, so ledgers and workflows never touch real data.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.RETRONAUT_DATA = mkdtempSync(join(tmpdir(), 'retronaut-test-'))
