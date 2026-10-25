// Dev loop: vite for the renderer, esbuild watching the main process, then Electron.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

const run = (cmd, args, env = {}) =>
  spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })

const children = [run('npx', ['vite']), run('node', ['scripts/build.mjs', '--watch'])]
while (!existsSync('dist/main.cjs') || !existsSync('dist/retronaut.mjs')) await wait(200)
const electron = run('npx', ['electron', '.'], { RETRONAUT_DEV_URL: 'http://localhost:5317' })
children.push(electron)

const stop = () => children.forEach((c) => c.kill())
electron.on('exit', () => { stop(); process.exit(0) })
process.on('SIGINT', stop)
