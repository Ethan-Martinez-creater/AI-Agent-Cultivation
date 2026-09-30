import {
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import { z } from 'zod';
import { AvatarStore } from './avatar-store.js';

export function registerDesktopIpc(
  window: BrowserWindow,
  validSender: (event: IpcMainInvokeEvent) => boolean,
  userData: string,
): void {
  const avatars = new AvatarStore(userData, (bytes) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('Image decode failed');
    const { width, height } = image.getSize();
    if (width > 2048 || height > 2048) throw new Error('Image too large');
    const edge = Math.min(width, height);
    return image
      .crop({
        x: Math.floor((width - edge) / 2),
        y: Math.floor((height - edge) / 2),
        width: edge,
        height: edge,
      })
      .resize({ width: 256, height: 256, quality: 'best' })
      .toPNG();
  });
  const register = (
    channel: string,
    parse: (args: unknown[]) => unknown,
    handle: (value: unknown) => unknown | Promise<unknown>,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!validSender(event)) throw new Error('IPC sender denied');
      try {
        return await handle(parse(args));
      } catch {
        throw new Error('桌面操作失败，请检查输入后重试');
      }
    });
  };
  const noArgs = (args: unknown[]) => z.tuple([]).parse(args);
  register('desktop:windowState', noArgs, () => ({ maximized: window.isMaximized() }));
  register('desktop:minimize', noArgs, () => window.minimize());
  register('desktop:toggleMaximize', noArgs, () => {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  register('desktop:close', noArgs, () => window.close());
  register(
    'desktop:copyText',
    (args) => z.tuple([z.string().max(65536)]).parse(args)[0],
    (text) => clipboard.writeText(text as string),
  );
  register('avatars:import', noArgs, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择道友头像',
      properties: ['openFile'],
      filters: [{ name: '人物头像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return avatars.importSelectedFile(result.filePaths[0]);
  });
  register(
    'avatars:read',
    (args) => z.tuple([z.string().max(80)]).parse(args)[0],
    (ref) => avatars.read(ref as string),
  );
  const notify = () => {
    if (!window.isDestroyed())
      window.webContents.send('desktop:windowStateChanged', { maximized: window.isMaximized() });
  };
  window.on('maximize', notify);
  window.on('unmaximize', notify);
}
