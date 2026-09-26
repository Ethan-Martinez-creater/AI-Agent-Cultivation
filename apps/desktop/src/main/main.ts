import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  databasePath,
  Gate1SqliteRepository,
  Gate2SqliteRepository,
  Gate2VectorRepository,
  openDatabase,
} from '@cultivation/persistence';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { Gate2MemoryService } from '@cultivation/application/gate2-memory-service';
import { Gate2HybridMemoryService } from '@cultivation/application/gate2-hybrid-memory-service';
import { SkillService, type SkillServiceStore } from '@cultivation/application/skill-service';
import { AiSdkModelGateway, FakeModelGateway } from '@cultivation/agent-runtime';
import type {
  EmbeddingGateway,
  MemoryCandidateExtractor,
  ModelGateway,
} from '@cultivation/application';
import { ElectronSecretStore } from './secret-store.js';
import { registerGate1Ipc } from './gate1-ipc.js';
import { registerGate2Ipc } from './gate2-ipc.js';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Lets smoke tests keep all Electron data in the workspace instead of the host profile.
if (process.env.CULTIVATION_USER_DATA_DIR) {
  mkdirSync(process.env.CULTIVATION_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.CULTIVATION_USER_DATA_DIR);
}

function createWindow(
  service: Gate1Service,
  memoryService: Gate2MemoryService,
  skillService: SkillService,
  hybridMemory: Gate2HybridMemoryService,
): void {
  const preload = join(__dirname, 'preload.js');
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());

  const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const allowedUrl = devUrl ? new URL(devUrl).origin : null;
  const rendererFile = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  const allowedFilePath = new URL(pathToFileURL(rendererFile).href).pathname;
  const csp = devUrl
    ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );

  const validSender = (event: Electron.IpcMainInvokeEvent): boolean => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return false;
    const url = event.senderFrame.url;
    if (allowedUrl) return new URL(url).origin === allowedUrl;
    try {
      return new URL(url).protocol === 'file:' && new URL(url).pathname === allowedFilePath;
    } catch {
      return false;
    }
  };
  const noArgs = z.tuple([]);
  ipcMain.removeHandler('app:getVersion');
  ipcMain.removeHandler('health:ping');
  ipcMain.handle('app:getVersion', (event, ...args: unknown[]) => {
    if (!validSender(event)) throw new Error('IPC sender denied');
    noArgs.parse(args);
    return app.getVersion();
  });
  ipcMain.handle('health:ping', (event, ...args: unknown[]) => {
    if (!validSender(event)) throw new Error('IPC sender denied');
    noArgs.parse(args);
    const db = openDatabase(databasePath(app.getPath('userData')));
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return { status: row.ok === 1 ? 'ok' : 'error', database: 'sqlite' };
    } finally {
      db.close();
    }
  });
  registerGate1Ipc(window, validSender, service);
  registerGate2Ipc(validSender, memoryService, skillService, hybridMemory);

  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(rendererFile);
}

app
  .whenReady()
  .then(() => {
    const db = openDatabase(databasePath(app.getPath('userData')));
    db.prepare('SELECT 1').get();
    app.once('before-quit', () => db.close());
    if (process.argv.includes('--gate0-smoke')) {
      process.stdout.write('GATE0_SMOKE_OK native_sqlite=ok\n');
      app.exit(0);
      return;
    }
    const store = new Gate1SqliteRepository(db);
    const gate2Store = new Gate2SqliteRepository(db);
    let vectorAvailable = false;
    try {
      const extension = app.isPackaged
        ? join(process.resourcesPath, 'vec0.dll')
        : join(process.cwd(), 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll');
      db.loadExtension(extension);
      db.prepare('SELECT vec_version()').get();
      vectorAvailable = true;
    } catch {
      // FTS5 remains fully functional if an installation cannot load sqlite-vec.
    }
    const vectorStore = new Gate2VectorRepository(db, vectorAvailable);
    const secretStore = new ElectronSecretStore(safeStorage);
    const gateway: ModelGateway & MemoryCandidateExtractor & EmbeddingGateway =
      process.argv.includes('--gate1-fake-model')
        ? new FakeModelGateway()
        : new AiSdkModelGateway((runtimeProfileId) => service.resolveRuntime(runtimeProfileId));
    const memoryService = new Gate2MemoryService(store, gate2Store, gateway);
    const hybridMemory = new Gate2HybridMemoryService(store, memoryService, vectorStore, gateway);
    const skillStore: SkillServiceStore = {
      getSkill: async (id) => gate2Store.getSkill(id),
      listSkills: async () => gate2Store.listSkills(),
      saveSkill: async (skill) => gate2Store.saveSkill(skill),
      listSkillRevisions: async (id) => gate2Store.listSkillRevisions(id),
      getAssignment: async (teammateId, skillId) =>
        gate2Store.listSkillAssignments(teammateId).find((item) => item.skillId === skillId) ??
        null,
      listAssignmentsForTeammate: async (teammateId) => gate2Store.listSkillAssignments(teammateId),
      saveAssignment: async (assignment) => {
        const existing = gate2Store
          .listSkillAssignments(assignment.teammateId)
          .some((item) => item.skillId === assignment.skillId);
        if (!existing) gate2Store.assignSkill(assignment.teammateId, assignment.skillId);
        gate2Store.setSkillEnabled(assignment.teammateId, assignment.skillId, assignment.enabled);
      },
      deleteAssignment: async (teammateId, skillId) => {
        gate2Store.unassignSkill(teammateId, skillId);
      },
    };
    const skillService = new SkillService(skillStore, {
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
    });
    const service: Gate1Service = new Gate1Service(store, secretStore, gateway, {
      load: async (teammateId, query) => ({
        relevantMemories: await hybridMemory.retrieve(teammateId, query),
        skills: gate2Store.listSkills(),
        skillAssignments: gate2Store.listSkillAssignments(teammateId),
      }),
    });
    createWindow(service, memoryService, skillService, hybridMemory);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createWindow(service, memoryService, skillService, hybridMemory);
    });
  })
  .catch((error: unknown) => {
    process.stderr.write(`Startup failed: ${String(error)}\n`);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
