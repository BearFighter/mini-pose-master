// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MpmApi, MpmEventName, MpmEventPayloads } from '../../src/shared/ipc'

const invoke = (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(`mpm:${channel}`, ...args)

const api: MpmApi = {
  app: {
    info: () => invoke('app.info'),
    checkUpdate: () => invoke('app.checkUpdate'),
    installUpdate: () => invoke('app.installUpdate')
  },
  blender: {
    status: () => invoke('blender.status'),
    setPath: (path) => invoke('blender.setPath', path),
    download: () => invoke('blender.download'),
    cancelDownload: () => invoke('blender.cancelDownload')
  },
  dialog: {
    openFile: (args) => invoke('dialog.openFile', args),
    saveFile: (args) => invoke('dialog.saveFile', args)
  },
  project: {
    create: (args) => invoke('project.create', args),
    open: (path) => invoke('project.open', path),
    save: (args) => invoke('project.save', args),
    importModel: (args) => invoke('project.importModel', args),
    addWeapon: (args) => invoke('project.addWeapon', args)
  },
  job: {
    run: (args) => invoke('job.run', args),
    cancel: (jobId) => invoke('job.cancel', jobId)
  },
  library: {
    list: () => invoke('library.list'),
    install: (packId) => invoke('library.install', packId),
    installFromFile: (args) => invoke('library.installFromFile', args),
    importClip: (args) => invoke('library.importClip', args)
  },
  shell: {
    showItemInFolder: (path) => invoke('shell.showItemInFolder', path)
  },
  on<E extends MpmEventName>(event: E, cb: (payload: MpmEventPayloads[E]) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: MpmEventPayloads[E]) => cb(payload)
    ipcRenderer.on(event, listener)
    return () => {
      ipcRenderer.removeListener(event, listener)
    }
  }
}

contextBridge.exposeInMainWorld('mpm', api)
