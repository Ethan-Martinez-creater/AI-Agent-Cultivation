import { contextBridge, ipcRenderer } from 'electron';

export interface CultivationBridge {
  app: { getVersion(): Promise<string> };
  health: { ping(): Promise<{ status: string; database: string }> };
}

const bridge: CultivationBridge = {
  app: { getVersion: () => ipcRenderer.invoke('app:getVersion') },
  health: { ping: () => ipcRenderer.invoke('health:ping') },
};

contextBridge.exposeInMainWorld('cultivation', bridge);
