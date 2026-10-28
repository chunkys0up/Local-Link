// In development the app runs inside Electron's own Electron.app, so macOS calls it
// "Electron" (menu bar, Dock, ⌘-Tab) and shows Electron's icon. This renames that bundle
// to Retronaut and gives it Retronaut's icon, then re-signs it (editing a bundle breaks
// its signature) and tells Launch Services. Runs after npm install and before npm run dev;
// does nothing once done.
//
// macOS ties Accessibility and Screen Recording to the bundle's signature, so the first
// rename means turning those back on for Retronaut in System Settings.
//
//   node scripts/name-dev-app.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'Retronaut'
const APP = join(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app')
const PLIST = join(APP, 'Contents', 'Info.plist')
const ICON = join(import.meta.dirname, '..', 'build', 'icon.icns')

if (process.platform !== 'darwin' || !existsSync(PLIST)) process.exit(0)

const plist = (command) => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, PLIST], { encoding: 'utf8' }).trim()
const read = (key) => {
  try {
    return plist(`Print :${key}`)
  } catch {
    return null
  }
}

const bundleIcon = join(APP, 'Contents', 'Resources', read('CFBundleIconFile') || 'electron.icns')
const named = read('CFBundleName') === NAME && read('CFBundleDisplayName') === NAME
const iconed = existsSync(ICON) && existsSync(bundleIcon) && readFileSync(ICON).equals(readFileSync(bundleIcon))
if (named && iconed) process.exit(0)

// Rewriting a running app's bundle can crash it; try again next launch.
let running = false
try {
  execFileSync('pgrep', ['-f', join(APP, 'Contents', 'MacOS', 'Electron')], { stdio: 'ignore' })
  running = true
} catch {
  // not running
}
if (running) {
  console.log(`[name-dev-app] Electron is running; quit Retronaut and run this again to rename it to ${NAME}.`)
  process.exit(0)
}

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (read(key) === null) plist(`Add :${key} string ${NAME}`)
  else plist(`Set :${key} ${NAME}`)
}
if (existsSync(ICON)) copyFileSync(ICON, bundleIcon)
execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'ignore' })
execFileSync('touch', [APP])
try {
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', APP], { stdio: 'ignore' })
} catch {
  // the name still shows; Finder may take a moment to notice
}
console.log(`[name-dev-app] Renamed the development app to ${NAME}. Turn Accessibility and Screen Recording back on for it in System Settings › Privacy & Security.`)
