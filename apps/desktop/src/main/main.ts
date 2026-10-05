import { app, BrowserWindow, ipcMain, Menu, Notification, safeStorage } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DomainError } from '@cultivation/shared';
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
  R2ContinuationRepository,
  R3SqliteRepository,
  R32AvailabilityRepository,
  R4RoutingRepository,
  W1WorkflowRepository,
  W2WorkflowRepository,
  W22WorkspaceMutationRepository,
  ResearchSourceRepository,
  ResearchInputArtifactRepository,
  openDatabase,
} from '@cultivation/persistence';
import { Gate1Service, type ChatPromptContext } from '@cultivation/application/gate1-service';
import { Gate2MemoryService } from '@cultivation/application/gate2-memory-service';
import { Gate2HybridMemoryService } from '@cultivation/application/gate2-hybrid-memory-service';
import { SkillService, type SkillServiceStore } from '@cultivation/application/skill-service';
import {
  AiSdkModelGateway,
  FakeModelGateway,
  FakeDecisionGateway,
  TypeSafeDecisionGateway,
  AiSdkModelAvailabilityProbe,
} from '@cultivation/agent-runtime';
import {
  AvailabilityService,
  AvailabilityAwareModelGateway,
  RoutingEligibilityService,
  RoutingPlanner,
  RoutingMissionService,
  R4DecisionService,
  WorkflowService,
  workflowArtifactContext,
} from '@cultivation/application';
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
import { R3DecisionConfigController } from './r3-config.js';
import { R3ShadowMissionObserver } from './r3-shadow-observer.js';
import { registerR3Ipc } from './r3-ipc.js';
import { registerAvailabilityIpc } from './r3-2-ipc.js';
import type { ModelAvailabilityProjection } from '@cultivation/domain';
import { registerDesktopIpc } from './desktop-ipc.js';
import { registerRoutingIpc } from './r4-ipc.js';
import { buildR3ShadowCandidates } from './r3-candidate-context.js';
import { routingFixtureGateway } from './r4-fixture-decision.js';
import { WorkflowMissionAdapter } from './w1-mission-adapter.js';
import { WorkflowFixtureGateway, registerWorkflowFixtures } from './w1-fixture.js';
import { registerWorkflowIpc } from './w1-ipc.js';
import { ResearchInputArtifactService } from './w23-input-artifacts.js';
import { registerResearchInputIpc } from './w23-input-ipc.js';
import { ContractFixtureGateway, registerContractFixtures } from './w2-fixture.js';
import { installOfficialBuiltinWorkflows } from './w2-builtin-installation.js';
import { officialWorkflowValidationPolicies } from './w21-validation-policy.js';
import { NewsWorkflowFixtureGateway } from './w21-fixture.js';
import { SoftwareWorkflowFixtureGateway } from './w22-fixture.js';
import { ResearchWorkflowFixtureGateway } from './w23-fixture.js';
import {
  softwareWorkflowValidationPolicy,
  softwareToolScope,
  verifiedSoftwareFacts,
} from './w22-validation-policy.js';
import { WorkflowToolGuard } from './w22-workspace-mutations.js';
import {
  softwareManualVerificationFacts,
  softwareMixedVerificationBoundary,
} from './w22-mixed-verification.js';
import { researchIntegrityFacts } from './w23-facts.js';
import { researchWorkflowValidationPolicy } from './w23-validation-policy.js';
import { researchMixedExperimentBoundary } from './w23-mixed-experiment.js';
import { researchFailureContext } from './w23-artifact-context.js';
import { generationFoundation } from './g1-foundation.js';
import { h3GenerationFoundation } from './g2-foundation.js';
import { registerGenerationChatIpc } from './g2-ipc.js';
import { generationPreview } from './g2-preview.js';
import { seedGenerationWorkspaceFixture } from './g1-fixture.js';
import { registerGenerationIpc } from './g1-ipc.js';
import type { GenerationService } from '@cultivation/application/g1-generation';

function notifyAvailability(value: ModelAvailabilityProjection): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('availability:event', value);
  }
}

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
  r3Config: R3DecisionConfigController,
  r3Store: R3SqliteRepository,
  r3Observer: R3ShadowMissionObserver,
  availability: AvailabilityService,
  routing: RoutingMissionService,
  routingStore: R4RoutingRepository,
  workflows: WorkflowService,
  researchInputs: ResearchInputArtifactService,
  generation: GenerationService,
  g2: ReturnType<typeof h3GenerationFoundation> | null,
): BrowserWindow {
  const preload = join(__dirname, 'preload.js');
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#f6f8fc',
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  window.setMenu(null);
  window.once('ready-to-show', () => window.show());

  const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const allowedUrl = devUrl ? new URL(devUrl).origin : null;
  const rendererFile = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  const allowedFilePath = new URL(pathToFileURL(rendererFile).href).pathname;
  const csp = devUrl
    ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' cultivation-media:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' cultivation-media:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
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
  registerDesktopIpc(window, validSender, app.getPath('userData'));
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
    (runtimeProfileId) => {
      for (const teammate of capabilityStore.listTeammatesUsingRuntime(runtimeProfileId)) {
        capabilities.rebuild(teammate.id);
      }
    },
    async (runtimeProfileId) => {
      if (
        service.listRuntimeProfiles().find((row) => row.id === runtimeProfileId)
          ?.executionProtocol === 'GENERATION'
      ) {
        const owner = service
          .listTeammates()
          .find((t) => t.currentRuntimeProfileId === runtimeProfileId);
        if (g2 && owner) {
          const state = await g2.availability.recheck(owner.id);
          return {
            ok: state.status === 'AVAILABLE',
            message: state.status === 'AVAILABLE' ? '模型可用' : '模型不可用，请重新检测',
          };
        }
        return service.testConnection(runtimeProfileId);
      }
      const teammate = service
        .listTeammates()
        .find(
          (row) =>
            row.executorKind === 'MODEL_RUNTIME' &&
            row.currentRuntimeProfileId === runtimeProfileId,
        );
      if (!teammate) return service.testConnection(runtimeProfileId);
      const state = await availability.recheck(teammate.id);
      return {
        ok: state.status === 'AVAILABLE',
        message:
          state.status === 'AVAILABLE'
            ? '模型可用'
            : state.status === 'UNSTABLE'
              ? '连接不稳定'
              : '模型不可用，请检查配置后重新检测',
      };
    },
    (credentialId) => {
      for (const teammate of service.listTeammates()) {
        const runtime = service
          .listRuntimeProfiles()
          .find((row) => row.id === teammate.currentRuntimeProfileId);
        if (runtime?.credentialId !== credentialId) continue;
        const state =
          runtime?.executionProtocol === 'GENERATION' && g2
            ? g2.availability.get(teammate.id)
            : availability.get(teammate.id);
        if (state) notifyAvailability(state);
      }
    },
  );
  registerGate2Ipc(validSender, memoryService, skillService, hybridMemory);
  registerGate3Ipc(validSender, missions, missionStore, partyMissions, parties, (mission) =>
    r3Observer.observeMission(mission),
  );
  registerGate4Ipc(window, validSender, tools);
  registerGate6Ipc(validSender, experience);
  registerR1Ipc(validSender, capabilities);
  registerR2Ipc(validSender, humanBridge, externalWork, partyMissions, tools, (continuation) =>
    missionStore.getMission(continuation.missionId)?.mode === 'SOLO'
      ? missions.resumeExternalWork({
          ...continuation,
          publicResult: continuation.publicResult ?? null,
        })
      : partyMissions.resumeExternalWork(continuation),
  );
  registerR3Ipc(validSender, r3Config, r3Store);
  const displayedAvailability = {
    get: (id: string) => {
      const t = service.listTeammates().find((t) => t.id === id);
      const runtime = service
        .listRuntimeProfiles()
        .find((r) => r.id === t?.currentRuntimeProfileId);
      return runtime?.executionProtocol === 'GENERATION' && g2
        ? g2.availability.get(id)
        : availability.get(id);
    },
    recheck: (id: string) => {
      const t = service.listTeammates().find((t) => t.id === id);
      const runtime = service
        .listRuntimeProfiles()
        .find((r) => r.id === t?.currentRuntimeProfileId);
      return runtime?.executionProtocol === 'GENERATION' && g2
        ? g2.availability.recheck(id)
        : availability.recheck(id);
    },
    prepare: (input: Parameters<AvailabilityService['prepare']>[0]) => {
      const runtime = service.listRuntimeProfiles().find((r) => r.id === input.runtimeProfileId);
      return runtime?.executionProtocol === 'GENERATION' && g2
        ? g2.availability.prepare(input)
        : availability.prepare(input);
    },
  };
  registerAvailabilityIpc(validSender, displayedAvailability, service);
  registerRoutingIpc(validSender, routing, routingStore, r3Config, (mission) =>
    r3Observer.observeMission(mission),
  );
  registerWorkflowIpc(validSender, workflows);
  registerResearchInputIpc(window, validSender, researchInputs);
  registerGenerationIpc(validSender, generation);
  if (g2)
    registerGenerationChatIpc(
      window,
      validSender,
      g2.chat,
      g2.media,
      generationPreview(
        window.webContents.session,
        g2.repository,
        g2.artifacts,
        allowedUrl ?? 'file://',
      ),
      g2.listAttachments,
    );

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
      const externalWorkContinuations = new R2ContinuationRepository(db);
      const r3Store = new R3SqliteRepository(db);
      const routingStore = new R4RoutingRepository(db);
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
      const fakeDecision = process.argv.includes('--r3-fake-decision');
      const fakeDecisionError = process.argv.includes('--r3-fake-decision-error');
      const r3GatewayFactory = (apiKey: string, timeoutMs: number) =>
        fakeDecisionError
          ? {
              evaluate: async () => ({
                answers: {},
                confidence: {},
                selectedAction: null,
                errorCode: 'PROVIDER_UNAVAILABLE' as const,
              }),
            }
          : fakeDecision
            ? new FakeDecisionGateway()
            : new TypeSafeDecisionGateway({ apiKey, timeoutMs });
      const r3Config = new R3DecisionConfigController(r3Store, secretStore, async (apiKey) => {
        if (fakeDecision || fakeDecisionError) return { ok: true, model: 'jev-1.13.0' };
        const gateway = new TypeSafeDecisionGateway({ apiKey });
        const result = await gateway.testConnection();
        return { ok: result.ok, model: result.model };
      });
      const workflowStore = new W1WorkflowRepository(db);
      const workflowFoundation = new W2WorkflowRepository(db);
      const researchSources = new ResearchSourceRepository(db);
      const workspaceMutations = new W22WorkspaceMutationRepository(db);
      const rawGateway: ModelGateway & MemoryCandidateExtractor & EmbeddingGateway =
        process.argv.includes('--gate1-fake-model')
          ? process.argv.includes('--w23-fake-research')
            ? new ResearchWorkflowFixtureGateway(() => {
                for (const run of workflowStore
                  .listRuns()
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
                  const detail = workflowStore.detail(run.id)!;
                  const step = detail.steps.find(
                    (item) =>
                      ['RUNNING', 'WAITING'].includes(item.state) &&
                      item.missionId !== null &&
                      gate3Store.getMission(item.missionId)?.state === 'RUNNING',
                  );
                  if (step && detail.version.validationPolicy === 'research-integrity-v1')
                    return { detail, step };
                }
                return null;
              })
            : process.argv.includes('--w22-fake-software')
              ? new SoftwareWorkflowFixtureGateway(() => {
                  for (const run of workflowStore
                    .listRuns()
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
                    const detail = workflowStore.detail(run.id)!;
                    const step = detail.steps.find(
                      (item) =>
                        ['RUNNING', 'WAITING'].includes(item.state) &&
                        item.missionId !== null &&
                        gate3Store.getMission(item.missionId)?.state === 'RUNNING',
                    );
                    if (step && detail.version.validationPolicy === 'software-integrity-v1')
                      return { detail, step };
                  }
                  return null;
                })
              : process.argv.includes('--w21-fake-news')
                ? new NewsWorkflowFixtureGateway(
                    () => {
                      for (const run of workflowStore
                        .listRuns()
                        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
                        const detail = workflowStore.detail(run.id)!;
                        const step = detail.steps.find(
                          (item) =>
                            ['RUNNING', 'WAITING'].includes(item.state) &&
                            item.missionId !== null &&
                            gate3Store.getMission(item.missionId)?.state === 'RUNNING',
                        );
                        if (step && detail.version.validationPolicy === 'news-integrity-v1')
                          return { detail, step };
                      }
                      return null;
                    },
                    join(process.cwd(), 'scripts', 'fixtures', 'news-media'),
                  )
                : process.argv.includes('--w2-fake-workflow')
                  ? new ContractFixtureGateway()
                  : process.argv.includes('--w1-fake-workflow')
                    ? new WorkflowFixtureGateway()
                    : new FakeModelGateway()
          : new AiSdkModelGateway(async (runtimeProfileId) => {
              const resolved = await service.resolveRuntime(runtimeProfileId);
              if (resolved.kind === 'GENERATION_HTTP')
                throw new DomainError('INVALID_INPUT', '生成服务不能执行文本对话');
              return { ...resolved, kind: resolved.kind };
            });
      const availability = new AvailabilityService(
        new R32AvailabilityRepository(db),
        store,
        process.argv.includes('--gate1-fake-model')
          ? { probe: async () => ({ kind: 'SUCCESS' as const, code: 'PROBE_SUCCEEDED' }) }
          : new AiSdkModelAvailabilityProbe((runtimeProfileId) =>
              service.resolveRuntime(runtimeProfileId).then((r) => {
                if (r.kind === 'GENERATION_HTTP')
                  throw new DomainError('INVALID_INPUT', '生成服务不能使用文本检测');
                return { ...r, kind: r.kind };
              }),
            ),
        { onChanged: notifyAvailability },
      );
      const eligibility = new RoutingEligibilityService(
        store,
        availability,
        (teammateId, dimension) =>
          capabilities
            .profile(teammateId)
            .dimensions.some(
              (item) => item.dimension === dimension && item.prior?.supported === true,
            ),
      );
      // Both production and Fake adapters implement these ancillary ports; the
      // decorator preserves exactly the methods present on its wrapped adapter.
      const gateway = new AvailabilityAwareModelGateway(
        rawGateway,
        availability,
      ) as AvailabilityAwareModelGateway & MemoryCandidateExtractor & EmbeddingGateway;
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
      const service: Gate1Service = new Gate1Service(store, secretStore, gateway, promptContext, {
        getDescriptor: (runtimeId) => generation.gateway.getDescriptor(runtimeId),
      });
      const permissionEngine = new PermissionEngine(gate3Store);
      const registry = new ToolRegistry();
      const mcpHost = new McpHost();
      const tools = new Gate4ToolsService(gate4Store, registry, mcpHost);
      await tools.initialize();
      const g2 = process.argv.includes('--g1-fake-generation')
        ? null
        : h3GenerationFoundation({
            db,
            userData: app.getPath('userData'),
            store,
            missions: gate3Store,
            tools: gate4Store,
            permission: permissionEngine,
            secrets: secretStore,
            onAvailabilityChanged: { onChanged: notifyAvailability },
          });
      const generation =
        g2 ??
        generationFoundation({
          db,
          userData: app.getPath('userData'),
          store,
          missions: gate3Store,
          tools: gate4Store,
          permission: permissionEngine,
          testOnly: process.argv.includes('--g1-fake-generation'),
        });
      if (!g2) await generation.service.recover();
      if (
        process.argv.includes('--g1-fake-generation') &&
        process.argv.includes('--g1-workspace-fixture') &&
        process.env.CULTIVATION_G1_WORKSPACE_DIR &&
        generation.service.list().length === 0
      ) {
        await seedGenerationWorkspaceFixture(
          service,
          generation.service,
          gate3Store,
          gate4Store,
          process.env.CULTIVATION_G1_WORKSPACE_DIR,
          process.argv.includes('--g1-deny-write'),
        );
      }
      const externalWork = new ExternalWorkService(
        r2Store,
        {
          validateArtifact: async (relativePath, constraints) => {
            const root = tools.getWorkspace().rootPath;
            if (!root) throw new Error('请先选择 Workspace Root');
            const inspected = await (
              await FileWorkspace.open(root)
            ).inspectArtifact(relativePath, constraints.maxSizeBytes, true);
            if (!constraints.allowedExtensions.includes(inspected.extension)) {
              throw new Error('Artifact extension 不符合要求');
            }
            return {
              relativePath: inspected.path,
              fileName: inspected.fileName,
              extension: inspected.extension,
              sizeBytes: inspected.sizeBytes,
              contentHash: inspected.contentHash!,
            };
          },
        },
        { continuations: externalWorkContinuations },
      );
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
      const workflowToolGuard = new WorkflowToolGuard(
        {
          findStepByMissionId: (id) => workflowStore.findStepByMissionId(id),
          detail: (id) => workflowStore.detail(id),
          bindMissionRun: (step, context) => {
            const run = gate3Store.getRun(context.runId);
            if (
              !run ||
              run.missionId !== context.missionId ||
              run.status !== 'RUNNING' ||
              gate3Store.listRuns(context.missionId).at(-1)?.id !== run.id
            )
              throw new Error('Workflow Tool must use the actual current MissionRun');
            if (step.missionRunId === run.id) return step;
            const bound = { ...step, missionRunId: run.id, updatedAt: new Date().toISOString() };
            if (!workflowStore.saveStep(bound, step.state))
              throw new Error('Workflow MissionRun binding changed');
            return bound;
          },
        },
        workspaceMutations,
        () => tools.getWorkspace().rootPath,
        (detail) => softwareToolScope(detail),
      );
      const toolRuntime = new ToolRuntime(registry, permissionEngine, workflowToolGuard);
      missions.attachTools(toolRuntime, gate4Store);
      const parties = new Gate5PartyService(gate5Store, store);
      const r3Observer = new R3ShadowMissionObserver(
        r3Config,
        r3Store,
        {
          teammates: store,
          skills: gate2Store,
          experiences: new Gate6SqliteRepository(db),
          capabilities,
          humanBridge,
          eligibility,
        },
        r3GatewayFactory,
      );
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
      partyMissions.attachExternalWork(externalWork, externalWorkContinuations);
      missions.attachHumanBridgeExecution(externalWork, externalWorkContinuations, {
        getByMissionId: (id) => {
          const assignment = routingStore.getByMissionId(id);
          return assignment?.externalWorkDraft
            ? { externalWorkDraft: assignment.externalWorkDraft }
            : null;
        },
      });
      missions.attachAssignmentGuard({
        hasAssignment: (id) => routingStore.getByMissionId(id) !== null,
      });
      const resumeExternalWork = (
        continuation: Parameters<Gate5CollaborationService['resumeExternalWork']>[0],
      ) =>
        gate3Store.getMission(continuation.missionId)?.mode === 'SOLO'
          ? missions.resumeExternalWork({
              ...continuation,
              publicResult: continuation.publicResult ?? null,
            })
          : partyMissions.resumeExternalWork(continuation);
      const routingDecision = new R4DecisionService({
        gateway: async () => {
          if (!routingStore.config().cloudEnabled) return null;
          const key = await r3Config.resolveKey();
          if (!key) return null;
          return process.argv.includes('--gate1-fake-model') &&
            process.argv.includes('--r4-fake-routing')
            ? routingFixtureGateway()
            : r3GatewayFactory(key, 6000);
        },
      });
      const routingPlanner = new RoutingPlanner(
        {
          listTeammates: () => store.listTeammates(),
          benchmarkScores: (id) =>
            Object.fromEntries(
              capabilities
                .profile(id)
                .dimensions.map((item) => [
                  item.dimension,
                  item.prior?.supported &&
                  typeof item.prior.normalizedScore === 'number' &&
                  Number.isFinite(item.prior.normalizedScore)
                    ? item.prior.normalizedScore
                    : null,
                ]),
            ),
          semanticMetadata: (id) => {
            const candidate = buildR3ShadowCandidates(id, {
              teammates: store,
              skills: gate2Store,
              experiences: new Gate6SqliteRepository(db),
              capabilities,
              eligibility,
            }).find((item) => item.id === id);
            if (!candidate) throw new Error('Routing candidate is no longer eligible');
            return candidate;
          },
          getParty: (id) => {
            const party = gate5Store.getParty(id);
            return party
              ? {
                  ...party,
                  memberTeammateIds: gate5Store
                    .listPartyMembers(id)
                    .map((member) => member.teammateId),
                }
              : null;
          },
          humanBridgeSupports: (id, dimensions) => {
            const profile = humanBridge.capabilityProfile();
            return (
              profile.teammate.id === id &&
              dimensions.every((dimension) =>
                profile.dimensions.some((item) => item.dimension === dimension && item.enabled),
              )
            );
          },
          appendRoutingReceipt: (receipt) =>
            gate3Store.transaction(() => {
              routingStore.appendRoutingReceipt(receipt);
              gate3Store.appendAuditEvent({
                id: crypto.randomUUID(),
                actorType: 'SYSTEM',
                actorId: null,
                action: 'routing.decided',
                targetType: 'ROUTING_RECEIPT',
                targetId: receipt.id,
                payloadJson: {
                  receiptId: receipt.id,
                  outcome: receipt.outcome,
                  reason: receipt.reason,
                  policyVersion: receipt.policyVersion,
                  assignmentKind: receipt.assignment?.kind ?? null,
                  coordinatorTeammateId: receipt.assignment?.coordinatorTeammateId ?? null,
                },
                createdAt: receipt.createdAt,
              });
            }),
        },
        eligibility,
        availability,
        routingDecision,
      );
      const routing = new RoutingMissionService(
        routingPlanner,
        routingStore,
        gate3Store,
        missions,
        partyMissions,
        parties,
        () => Boolean(tools.getWorkspace().rootPath),
      );
      const researchInputs = new ResearchInputArtifactService(
        new ResearchInputArtifactRepository(db),
        researchSources,
        workflowStore,
        toolRuntime,
        () => tools.getWorkspace().rootPath,
        (fact) => gate3Store.appendAuditEvent(fact),
        (fn) => db.transaction(fn)(),
      );
      workflowToolGuard.attachResearchInputCheck(
        (detail, consumed) => researchInputs.checkExperimentFiles(detail, consumed),
        (detail, stepRunId) => {
          for (const operation of workflowFoundation.listOperations(detail.run.id)) {
            if (
              operation.stepRunId === stepRunId &&
              ['PREPARED', 'APPLIED'].includes(operation.state)
            )
              if (
                !workflowFoundation.transitionOperation(
                  { ...operation, state: 'UNKNOWN', updatedAt: new Date().toISOString() },
                  operation.state,
                )
              )
                throw new Error('Research operation uncertainty could not be persisted');
          }
        },
      );
      missions.attachArtifactContext((id) => [
        ...workflowArtifactContext(workflowStore, id),
        ...researchInputs.contextForMission(id),
        ...researchFailureContext(workflowStore, researchFacts, id),
      ]);
      partyMissions.attachArtifactContext((id) => [
        ...workflowArtifactContext(workflowStore, id),
        ...researchInputs.contextForMission(id),
        ...researchFailureContext(workflowStore, researchFacts, id),
      ]);
      const softwareFacts = {
        ...verifiedSoftwareFacts(workspaceMutations, gate3Store),
        listManualForStep: softwareManualVerificationFacts(workflowStore, externalWork),
      };
      const mixedVerification = softwareMixedVerificationBoundary(
        workflowStore,
        gate3Store,
        externalWork,
        () => tools.getWorkspace().rootPath,
        softwareFacts,
      );
      if (
        process.argv.includes('--gate1-fake-model') &&
        process.argv.includes('--w22-stop-manual-continuation')
      ) {
        mixedVerification.compose = async () => new Promise<string>(() => {});
      }
      missions.attachCompletionBoundary(mixedVerification);
      const researchFacts = researchIntegrityFacts(
        workflowStore,
        gate3Store,
        researchSources,
        externalWork,
      );
      researchFacts.validateInputReferences = (version, inputs) =>
        researchInputs.validateInputs(version, inputs);
      researchFacts.bindInputReferences = (run) => researchInputs.bindRun(run);
      researchFacts.validateExperimentInputs = (detail, step, fact) =>
        researchInputs.validateExperimentInputs(detail, step, fact);
      researchFacts.validateExternalExperimentInputs = (detail, step, accepted) =>
        researchInputs.validateExternalExperimentInputs(detail, step, accepted);
      const mixedResearch = researchMixedExperimentBoundary(
        workflowStore,
        gate3Store,
        externalWork,
        workflowFoundation,
        () => tools.getWorkspace().rootPath,
        researchFacts,
      );
      if (
        process.argv.includes('--gate1-fake-model') &&
        process.argv.includes('--w23-stop-manual-continuation')
      )
        mixedResearch.compose = async () => new Promise<string>(() => {});
      missions.attachCompletionBoundary(mixedResearch, 'research-experiment-v1');
      const pendingExternalWork = externalWork.listPendingContinuations();
      const protectedMissionIds = new Set(pendingExternalWork.map((item) => item.missionId));
      for (const continuation of pendingExternalWork) {
        try {
          await resumeExternalWork(continuation);
        } catch {
          // The durable continuation remains available for the next startup; do not interrupt its Run.
        }
      }
      missions.recoverInterrupted(protectedMissionIds);
      const pendingRequestIds = new Set(pendingExternalWork.map((item) => item.requestId));
      for (const continuation of externalWork.resumeFinalizedRequests()) {
        if (pendingRequestIds.has(continuation.requestId)) continue;
        await resumeExternalWork(continuation);
      }
      experience.reconcileAll();
      const workflowMissions = new WorkflowMissionAdapter(
        routing,
        gate3Store,
        missions,
        partyMissions,
        externalWork,
        () => tools.getWorkspace().rootPath,
        workflowStore,
        () => registry.list(),
        workspaceMutations,
        (definition) =>
          store
            .listTeammates()
            .filter(
              (teammate) =>
                eligibility.evaluate(teammate.id, {
                  requiredCapabilities: definition.routing.requiredCapabilities,
                }).candidateEligible,
            )
            .map((teammate) => teammate.id),
        (workflowRunId) => researchFacts.listFailedExperimentAttemptsForRun?.(workflowRunId) ?? [],
        (detail) => researchInputs.checkExperimentFiles(detail),
      );
      if (
        process.argv.includes('--w1-fake-workflow') &&
        process.argv.includes('--w1-stop-before-step-commit')
      ) {
        const collect = workflowMissions.collectOutputs.bind(workflowMissions);
        workflowMissions.collectOutputs = async (id, root) => {
          const snapshot = await collect(id, root);
          await new Promise<void>(() => {});
          return snapshot;
        };
      }
      if (
        process.argv.includes('--gate1-fake-model') &&
        process.argv.includes('--w24-stop-before-artifact-commit')
      ) {
        const collect = workflowMissions.collectOutputs.bind(workflowMissions);
        workflowMissions.collectOutputs = async (...args) => {
          const snapshot = await collect(...args);
          if (args[2]?.id === 'S05') await new Promise<void>(() => {});
          return snapshot;
        };
      }
      if (
        process.argv.includes('--gate1-fake-model') &&
        process.argv.includes('--w2-stop-applied')
      ) {
        const verify = workflowMissions.verifyOperation.bind(workflowMissions);
        workflowMissions.verifyOperation = async (...args) => {
          if (args[0].state === 'APPLIED') await new Promise<void>(() => {});
          return verify(...args);
        };
      }
      const workflowPolicies = officialWorkflowValidationPolicies();
      workflowPolicies.register(
        'software-integrity-v1',
        softwareWorkflowValidationPolicy(softwareFacts),
      );
      workflowPolicies.register(
        'research-integrity-v1',
        researchWorkflowValidationPolicy(researchFacts),
      );
      const workflows = new WorkflowService(
        workflowStore,
        workflowMissions,
        undefined,
        workflowFoundation,
        workflowPolicies,
      );
      installOfficialBuiltinWorkflows(workflowStore, workflowFoundation);
      if (
        process.argv.includes('--w1-fake-workflow') &&
        process.argv.includes('--gate1-fake-model')
      )
        registerWorkflowFixtures(workflows);
      if (
        process.argv.includes('--w2-fake-workflow') &&
        process.argv.includes('--gate1-fake-model')
      )
        registerContractFixtures(workflowStore, workflowFoundation);
      await workflows.recover();
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
        r3Config,
        r3Store,
        r3Observer,
        availability,
        routing,
        routingStore,
        workflows,
        researchInputs,
        generation.service,
        g2,
      );
      if (g2) {
        let polling = false;
        const queryPending = async () => {
          if (polling) return;
          polling = true;
          try {
            for (const job of g2.repository.listRecoverableJobs()) {
              try {
                await g2.service.advance(job.id);
              } catch {
                /* Preserve durable state; no automatic resubmission for UNKNOWN. */
              }
            }
          } finally {
            polling = false;
          }
        };
        void queryPending();
        const timer = setInterval(() => void queryPending(), 10000);
        app.once('before-quit', () => clearInterval(timer));
      }
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
            r3Config,
            r3Store,
            r3Observer,
            availability,
            routing,
            routingStore,
            workflows,
            researchInputs,
            generation.service,
            g2,
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
