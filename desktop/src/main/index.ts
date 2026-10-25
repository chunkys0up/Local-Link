/**
 * Retronaut's Electron main process: runs the engine (agents, scripts, the HTTP API)
 * and one window for the UI. In dev the window loads vite; packaged, the engine
 * serves the built renderer itself.
 */

import { app, BrowserWindow, ipcMain, shell, systemPreferences } from 'electron'
import { join } from 'node:path'

import { onAttention } from './jobs'
import { installOverlay } from './overlay'
import { PORT } from './paths'
import { serve } from './server'
import { permissions, prepareEnvironment } from './startup'
import * as ui from './uiActivity'

const DEV_URL = process.env.RETRONAUT_DEV_URL

const PRIVACY_PANES: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

prepareEnvironment()
permissions.probe = () => ({
  accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  screen_recording: systemPreferences.getMediaAccessStatus('screen'),
})

ipcMain.handle('open-external', (_event, url: string) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url)
})
ipcMain.handle('open-privacy', (_event, pane: string) => {
  if (pane === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true) // also shows the system prompt
  if (PRIVACY_PANES[pane]) return shell.openExternal(PRIVACY_PANES[pane])
})

let mainWindow: BrowserWindow | null = null

/** Bring the app forward, on that workflow's page: a question, a card, or a result is waiting. */
function attend(workflowId: string): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  // Never while Retronaut is driving another app (the two would fight over focus):
  // wait for that to finish, then come forward.
  if (ui.current().active) {
    const off = ui.onChange((state) => {
      if (state.active) return
      off()
      attend(workflowId)
    })
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true })
  win.webContents.send('attention', workflowId)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Retronaut',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1c1b',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  // Links open in the browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadURL(DEV_URL ?? `http://127.0.0.1:${PORT}/`)
  // The frame's window is always there (hidden), so quit with the main window rather
  // than waiting for every window to close.
  win.on('closed', () => app.quit())
  mainWindow = win
}

app.whenReady().then(async () => {
  try {
    await serve(DEV_URL ? undefined : join(__dirname, 'renderer'))
  } catch (e) {
    console.error(`Couldn't start the engine on port ${PORT}: ${(e as Error).message}`)
    app.quit()
    return
  }
  installOverlay(DEV_URL ?? `http://127.0.0.1:${PORT}/`)
  onAttention((job) => attend(job.workflowId))
  createWindow()
})
