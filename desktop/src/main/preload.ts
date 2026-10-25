/** The little the renderer needs from Electron: open links and System Settings panes, and the frame's pill. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('retronaut', {
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openPrivacy: (pane: 'accessibility' | 'screen') => ipcRenderer.invoke('open-privacy', pane),
  /** The engine wants the person to look at a workflow (a question, a card, a result). */
  onAttention: (listener: (workflowId: string) => void) => {
    const handler = (_event: unknown, workflowId: string) => listener(workflowId)
    ipcRenderer.on('attention', handler)
    return () => ipcRenderer.removeListener('attention', handler)
  },
  overlay: {
    hover: (over: boolean) => ipcRenderer.send('overlay-hover', over),
    stop: () => ipcRenderer.send('overlay-stop'),
  },
  /** The pointer is over the picture-in-picture (it fades away) or has left it. */
  pipHover: (over: boolean) => ipcRenderer.send('pip-hover', over),
})
