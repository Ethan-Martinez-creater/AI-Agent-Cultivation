import { app, BrowserWindow, ipcMain, Notification, safeStorage } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  databasePath,
  Gate1SqliteRepository,
  Gate2SqliteRepository,
  Gate2VectorRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
  Gate5SqliteRepository,
  Gate6SqliteRepository,
  R0SqliteRepository,
  openDatabase,
} from '@cultivation/persistence';
import { Gate1Service, type ChatPromptContext } from '@cultivation/application/gate1-service';
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
import { registerGate3Ipc } from './gate3-ipc.js';
import { Gate3MissionService } from '@cultivation/application/gate3-mission-service';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import { ToolRegistry, ToolRuntime } from '@cultivation/application/tool-runtime';
import { McpHost } from './mcp-host.js';
import { Gate4ToolsService } from './gate4-tools-service.js';
import { registerGate4Ipc } from './gate4-ipc.js';
import { Gate5PartyService } from '@cultivation/application/gate5-party-service';
import { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import { Gate6ExperienceService } from '@cultivation/application/gate6-experience-service';
import { registerGate6Ipc } from './gate6-ipc.js';
import { R1CapabilityService } from '@cultivation/application/r1-capability-service';
import { registerR1Ipc } from './r1-ipc.js';
import {
  HumanBridgeService,
  ExternalWorkService,
  type R2HumanBridgeServiceStore,
} from '@cultivation/application/r2-human-bridge-service';
import { registerR2Ipc } from './r2-ipc.js';
import { FileWorkspace } from './file-workspace.js';

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
  missions: Gate3MissionService,
  missionStore: Gate3SqliteRepository,
  partyMissions: Gate5CollaborationService,
  parties: Gate5PartyService,
  tools: Gate4ToolsService,
  experience: Gate6ExperienceService,
  capabilities: R1CapabilityService,
  capabilityStore: R0SqliteRepository,
  humanBridge: HumanBridgeService,
  externalWork: ExternalWorkService,
): BrowserWindow {
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
  registerGate1Ipc(
    window,
    validSender,
    service,
    (teammateId) => {
      capabilities.rebuild(teammateId);
    },
    (runtimeProfileId) => {
      for (const teammate of capabilityStore.listTeammatesUsingRuntime(runtimeProfileId)) {
        capabilities.rebuild(teammate.id);
      }
    },
  );
  registerGate2Ipc(validSender, memoryService, skillService, hybridMemory);
  registerGate3Ipc(validSender, missions, missionStore, partyMissions, parties);
  registerGate4Ipc(window, validSender, tools);
  registerGate6Ipc(validSender, experience);
  registerR1Ipc(validSender, capabilities);
  registerR2Ipc(validSender, humanBridge, externalWork, partyMissions, tools);

  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(rendererFile);
  return window;
}

// Squirrel invokes the executable for install/update/uninstall hooks. Those
// invocations manage shortcuts and must not open the normal database or UI.
if (squirrelStartup) app.quit();
else if (process.platform === 'win32')
  app.setAppUserModelId('com.squirrel.AiAgentCultivation.AI-Agent-Cultivation');

if (!squirrelStartup)
  app
    .whenReady()
    .then(async () => {
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
      const gate3Store = new Gate3SqliteRepository(db);
      const gate4Store = new Gate4SqliteRepository(db);
      const gate5Store = new Gate5SqliteRepository(db);
      const experience = new Gate6ExperienceService(new Gate6SqliteRepository(db));
      const capabilityStore = new R0SqliteRepository(db);
      const capabilities = new R1CapabilityService(capabilityStore);
      const r2Store: R2HumanBridgeServiceStore = {
        ensureHumanBridgeTeammate: (input) => capabilityStore.ensureHumanBridgeTeammate(input),
        updateHumanBridgeDisplay: (teammateId, value) =>
          capabilityStore.updateHumanBridgeDisplay(teammateId, value),
        listHumanBridgeCapabilities: (teammateId) =>
          capabilityStore.listHumanBridgeCapabilities(teammateId),
        saveHumanBridgeCapability: (value) => capabilityStore.saveHumanBridgeCapability(value),
        listTeammateCapabilityStates: (teammateId) =>
          capabilityStore.listTeammateCapabilityStates(teammateId),
        replaceTeammateCapabilityStates: (teammateId, states) =>
          capabilityStore.replaceTeammateCapabilityStates(teammateId, states),
        listCapabilityEvidence: (teammateId, dimension) =>
          capabilityStore.listCapabilityEvidence(teammateId, dimension),
        appendCapabilityEvidenceBatch: (values) =>
          capabilityStore.appendCapabilityEvidenceBatch(values),
        saveExternalAppProfile: (value) => capabilityStore.saveExternalAppProfile(value),
        listExternalAppProfiles: (teammateId) =>
          capabilityStore.listExternalAppProfiles(teammateId),
        createExternalWorkRequest: (value) => capabilityStore.createExternalWorkRequest(value),
        getExternalWorkRequest: (id) => capabilityStore.getExternalWorkRequest(id),
        listExternalWorkRequests: (missionId, runId) =>
          capabilityStore.listExternalWorkRequests(missionId, runId),
        transitionExternalWorkRequest: (id, state, at, publicResult) =>
          capabilityStore.transitionExternalWorkRequest(id, state, at, publicResult),
        appendExternalWorkArtifact: (value) => capabilityStore.appendExternalWorkArtifact(value),
        listExternalWorkArtifacts: (requestId) =>
          capabilityStore.listExternalWorkArtifacts(requestId),
        getMission: (id) => gate3Store.getMission(id),
        listRuns: (missionId) => gate3Store.listRuns(missionId),
        listMissionParticipants: (missionId) => gate5Store.listMissionParticipants(missionId),
        transitionMission: (value, expectedState) =>
          gate3Store.transitionMission(value, expectedState),
        appendMissionEvent: (value) => gate3Store.appendMissionEvent(value),
        appendAuditEvent: (value) => gate3Store.appendAuditEvent(value),
        transaction: (fn) => gate3Store.transaction(fn),
      };
      const humanBridge = new HumanBridgeService(r2Store);
      humanBridge.bootstrap();
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
        listAssignmentsForTeammate: async (teammateId) =>
          gate2Store.listSkillAssignments(teammateId),
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
      const promptContext: ChatPromptContext = {
        load: async (teammateId, query) => ({
          relevantMemories: await hybridMemory.retrieve(teammateId, query),
          skills: gate2Store.listSkills(),
          skillAssignments: gate2Store.listSkillAssignments(teammateId),
        }),
      };
      const service: Gate1Service = new Gate1Service(store, secretStore, gateway, promptContext);
      const permissionEngine = new PermissionEngine(gate3Store);
      const registry = new ToolRegistry();
      const mcpHost = new McpHost();
      const tools = new Gate4ToolsService(gate4Store, registry, mcpHost);
      await tools.initialize();
      const externalWork = new ExternalWorkService(r2Store, {
        validateArtifact: async (relativePath, constraints) => {
          const root = tools.getWorkspace().rootPath;
          if (!root) throw new Error('请先选择 Workspace Root');
          const inspected = await (
            await FileWorkspace.open(root)
          ).inspectArtifact(relativePath, constraints.maxSizeBytes);
          if (!constraints.allowedExtensions.includes(inspected.extension)) {
            throw new Error('Artifact extension 不符合要求');
          }
          return {
            relativePath: inspected.path,
            fileName: inspected.fileName,
            extension: inspected.extension,
            sizeBytes: inspected.sizeBytes,
          };
        },
      });
      app.once('before-quit', () => {
        void tools.close();
      });
      const missions = new Gate3MissionService(
        gate3Store,
        store,
        permissionEngine,
        gateway,
        promptContext,
      );
      const toolRuntime = new ToolRuntime(registry, permissionEngine);
      missions.attachTools(toolRuntime, gate4Store);
      const parties = new Gate5PartyService(gate5Store, store);
      const partyMissions = new Gate5CollaborationService(
        gate3Store,
        gate5Store,
        parties,
        store,
        permissionEngine,
        gateway,
        promptContext,
        toolRuntime,
      );
      partyMissions.attachExternalWork(externalWork);
      await missions.recoverInterrupted();
      for (const continuation of externalWork.resumeFinalizedRequests()) {
        await partyMissions.resumeExternalWork(continuation);
      }
      experience.reconcileAll();
      let activeWindow = createWindow(
        service,
        memoryService,
        skillService,
        hybridMemory,
        missions,
        gate3Store,
        partyMissions,
        parties,
        tools,
        experience,
        capabilities,
        capabilityStore,
        humanBridge,
        externalWork,
      );
      externalWork.subscribeCreated((created) => {
        try {
          if (!Notification.isSupported()) return;
          const notice = new Notification({ title: created.title, body: '打开应用查看本尊待办。' });
          notice.on('click', () => {
            if (activeWindow.isDestroyed()) return;
            activeWindow.show();
            activeWindow.focus();
            activeWindow.webContents.send('r2:navigate', '/external-work');
          });
          notice.show();
        } catch {
          // Durable in-app tasks remain authoritative when Windows notifications fail.
        }
      });
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
          activeWindow = createWindow(
            service,
            memoryService,
            skillService,
            hybridMemory,
            missions,
            gate3Store,
            partyMissions,
            parties,
            tools,
            experience,
            capabilities,
            capabilityStore,
            humanBridge,
            externalWork,
          );
      });
    })
    .catch((error: unknown) => {
      process.stderr.write(`Startup failed: ${String(error)}\n`);
      app.exit(1);
    });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
