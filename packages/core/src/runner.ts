import { createOpenAI } from '@ai-sdk/openai';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import type {
  AgentStatus,
  RunnerCallbacks,
  RunnerConfig
} from './types.js';
import type { ContextMessage } from './context/types.js';
import type { WorkstationInfo } from './context/types.js';
import { createTools } from './tools/index.js';
import { ContextAssembler } from './context/index.js';
import { AgentLoopEngine, type ToolDefinition } from './loop/engine.js';
import { AiSdkStepAdapter } from './loop/adapter.js';
import type { StepModelCaller } from './loop/types.js';
import { AutoReviewer } from './review/reviewer.js';
import type { PermissionGate } from './review/types.js';
import { discoverSkills, type AgentSkill } from './skills/index.js';
import {
  SessionManager,
  findMostRecentSession,
  listSessions,
  resolveSessionFile,
  type SessionDescriptor
} from './session/index.js';
import { PromptHistoryStorage, type PromptHistoryEntry } from './storage/index.js';
import { MemorySynthesizer, type MemoryUpdateResult } from './memory/synthesizer.js';
import {
  DEFAULT_REASONING_EFFORT,
  ModelRouter,
  parseReasoningEffort,
  type ModelRole,
  type ModelRoute,
  type ReasoningEffort
} from './model/router.js';
import {
  createInitialEmotion,
  decayEmotion,
  getEmotionPromptModifier,
  updateEmotionOnInteraction,
  type EmotionState
} from './emotion/engine.js';

/** Default main agent model when neither config nor env supplies one. */
export const DEFAULT_MAIN_MODEL = 'gpt-4o';
/** Default review/tool model; deliberately cheaper than the main model. */
export const DEFAULT_REVIEW_MODEL = 'gpt-4o-mini';

export interface AgentRunnerOptions extends RunnerConfig {
  stepCaller?: StepModelCaller;
  /**
   * Reasoning effort applied to routes that name none — the console-level
   * counterpart of `OPENAI_REASONING_EFFORT`, and the same shape as
   * `modelName` / `apiKey`: an explicit option wins over the environment.
   *
   * Still subject to the router's capability check, so it reaches a thinking
   * model and leaves a non-reasoning one untouched. A per-role
   * `reasoningEffort` (constructor `modelRoutes` or `setModel`) is an explicit
   * instruction and wins over this.
   */
  defaultReasoningEffort?: ReasoningEffort;
  /**
   * Review/tool model caller. When omitted the runner builds a dedicated
   * adapter for `reviewModelName`. Injecting only `stepCaller` (a test seam)
   * leaves the reviewer rule-and-mode only rather than sharing the main caller.
   * The same auxiliary caller also drives memory extraction.
   */
  reviewModelCaller?: StepModelCaller;
  /** Interactive resolver for AutoReview `ask_user` verdicts (UI Approval Card). */
  permissionGate?: PermissionGate;
  tools?: Record<string, ToolDefinition>;
  /** Initial per-role routes merged over the default main route. */
  modelRoutes?: Partial<Record<ModelRole, ModelRoute>>;
  /**
   * Builds a step caller for a resolved route. Tests inject this to observe
   * which route a turn actually runs on without touching a real provider.
   */
  stepCallerFactory?: (route: ModelRoute) => StepModelCaller;
}

export interface AgentRunnerStatus {
  sessionId: string;
  sessionFile: string | null;
  leafId: string | null;
  messageCount: number;
  state: AgentStatus;
}

export class AgentRunner {
  public status: AgentStatus = 'idle';
  public config: RunnerConfig;
  public session: SessionManager;
  public history: PromptHistoryStorage;
  public assembler: ContextAssembler;
  public engine: AgentLoopEngine;
  public emotion: EmotionState = createInitialEmotion();
  /** Automatic approval gate; `undefined` when auto-review is disabled. */
  public reviewer?: AutoReviewer;
  /** Memory evolution engine over `MEMORY.md` / `USER.md` (`SOUL.md` untouched). */
  public synthesizer: MemorySynthesizer;
  /** Interactive resolver for escalated (`ask_user`) tool calls. */
  public permissionGate?: PermissionGate;
  /**
   * Role→route model registry. `main` is what the chat selector changes; the
   * other roles are the tool/auxiliary models configured in settings.
   */
  public models: ModelRouter;
  private currentAbortController: AbortController | null = null;
  private stepCaller: StepModelCaller;
  /** Credentials a route inherits when it does not carry its own. */
  private providerDefaults: { apiKey: string; baseURL?: string };
  /**
   * Builds a caller from a route. Absent when a `stepCaller` was injected (the
   * test seam), in which case that injected caller stands in for every route.
   */
  private callerFactory?: (route: ModelRoute) => StepModelCaller;

  constructor(options: AgentRunnerOptions = {}) {
    dotenv.config();

    const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
    this.config = {
      ...options,
      workspaceDir
    };

    // 1. Resolve the active JSONL session: explicit reference, newest for this
    //    workspace, or a brand new file.
    this.session = AgentRunner.resolveSession({
      sessionId: options.sessionId,
      newSession: options.newSession,
      workspaceDir,
      cwd: workspaceDir
    });

    // 2. Prompt history lives in its own SQLite database, decoupled from the tree.
    this.history = new PromptHistoryStorage({
      dbPath: options.historyDbPath ?? path.join(workspaceDir, '.myagent', 'history.db')
    });

    // 3. Context assembler: dynamic workstation + layered memory + branch messages.
    this.assembler = new ContextAssembler({
      session: this.session,
      workspaceDir,
      memoryDir: this.config.memoryDir,
      customInstructions: this.config.customInstructions,
      getPostureModifier: () => getEmotionPromptModifier(this.emotion)
    });

    // 4. Model separation: the main agent model and the (typically cheaper)
    //    review model are resolved independently so AutoReview can run on a
    //    different endpoint/model without touching the agent's own steps.
    //
    //    The review chain deliberately does NOT fall back to
    //    `OPENAI_MODEL_NAME`. A model must never approve its own actions, and a
    //    user who sets only the main model (a very common setup) would
    //    otherwise get a reviewer silently running on that same model and
    //    endpoint. Such a user gets the documented cheap default reviewer
    //    instead, which is exactly what the web console shell resolves
    //    (`OPENAI_REVIEW_MODEL_NAME ?? DEFAULT_REVIEW_MODEL`) — the two shells
    //    agree on one configuration.
    //
    //    A user who names BOTH and happens to name the same string still gets
    //    that one model: an explicit setting is an instruction, not an accident,
    //    and the console has a Settings field for exactly this. The reviewer is
    //    not silently disabled and no warning is raised here — a library must not
    //    write to stderr behind its embedder's back, and every shell already
    //    prints both models in its status output, which is where a human notices
    //    the collision.
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || 'placeholder-key';
    const baseURL = this.config.baseURL || process.env.OPENAI_BASE_URL;
    const modelName =
      this.config.modelName || process.env.OPENAI_MODEL_NAME || DEFAULT_MAIN_MODEL;
    const reviewModelName =
      this.config.reviewModelName ||
      process.env.OPENAI_REVIEW_MODEL_NAME ||
      DEFAULT_REVIEW_MODEL;

    this.config.modelName = modelName;
    this.config.reviewModelName = reviewModelName;

    // Reasoning is opt-in via `OPENAI_REASONING_EFFORT`, but the default is to
    // derive an effort for models that accept one. The parameter is rejected
    // with a provider 400 by every non-reasoning model, so the router only
    // attaches it where `supportsReasoningEffort` says the model takes it —
    // which is what lets a thinking main model stream reasoning while a
    // `gpt-4o`/`gpt-4o-mini` pair keeps working untouched. An unparseable value
    // is ignored rather than fatal, so a `.env` typo degrades to the default.
    // An explicit option (the console settings surface) wins over the
    // environment, matching how `modelName` and `apiKey` are resolved.
    const configuredEffort =
      options.defaultReasoningEffort ?? parseReasoningEffort(process.env.OPENAI_REASONING_EFFORT);

    // Role→route registry. The main model is the one the chat UI selects at
    // runtime; every other role is a tool/auxiliary model configured in
    // settings, and falls back to the default route when it is not set.
    const defaultRoute: ModelRoute = { model: modelName, apiKey, baseURL };
    const routes: Partial<Record<ModelRole, ModelRoute>> = {
      review: { model: reviewModelName },
      ...(process.env.OPENAI_MEMORY_MODEL_NAME
        ? { memory: { model: process.env.OPENAI_MEMORY_MODEL_NAME } }
        : {}),
      ...(process.env.OPENAI_TITLE_MODEL_NAME
        ? { title: { model: process.env.OPENAI_TITLE_MODEL_NAME } }
        : {}),
      ...options.modelRoutes
    };
    this.models = new ModelRouter({
      defaultRoute,
      routes,
      // Supplies the effort a route inherits when it names none. It is still
      // subject to the router's capability check, so a reasoning model thinks by
      // default while a `gpt-4o`/`gpt-4o-mini` pair stays unaffected. An
      // explicit per-role `reasoningEffort` is an instruction and always wins.
      defaultReasoningEffort: configuredEffort ?? DEFAULT_REASONING_EFFORT
    });
    this.providerDefaults = { apiKey, baseURL };

    // A route may name its own credentials/endpoint; otherwise it inherits the
    // runner-wide defaults so a role only has to name what differs.
    const callerFor = (route: ModelRoute): StepModelCaller => {
      const provider = createOpenAI({
        apiKey: route.apiKey ?? this.providerDefaults.apiKey,
        baseURL: route.baseURL ?? this.providerDefaults.baseURL
      });
      return new AiSdkStepAdapter(provider(route.model), {
        maxTokens: route.maxTokens,
        reasoningEffort: route.reasoningEffort
      });
    };
    // An injected `stepCaller` is the test seam: it stands in for every route
    // and `setModel` cannot swap it for a real provider.
    this.callerFactory = options.stepCallerFactory ?? (options.stepCaller ? undefined : callerFor);

    this.stepCaller = options.stepCaller ?? this.buildCaller(this.models.resolve('main'));

    // 5. Tools carry a dynamic abort signal so Ctrl+C tears down the process tree.
    const tools =
      options.tools ||
      createTools({
        workspaceDir,
        spilloverDir: this.config.spilloverDir,
        getSignal: () => this.currentAbortController?.signal
      });

    // 6. AutoReview gate: rules always run; the review model only sees calls the
    //    rule engine cannot classify. Tests can inject a mock review caller.
    //    The reviewer gets its OWN caller on the `review` route — never the main
    //    loop model, which must not approve its own actions.
    const autoReviewEnabled =
      this.config.autoReview ?? (process.env.SUPERIU_AUTO_REVIEW ?? '1') !== '0';
    this.config.autoReview = autoReviewEnabled;
    this.config.autoReviewMode =
      this.config.autoReviewMode ??
      (process.env.SUPERIU_AUTO_REVIEW_MODE === 'strict' ? 'strict' : 'lenient');

    const reviewCaller =
      options.reviewModelCaller ??
      (options.stepCaller ? undefined : this.buildCaller(this.models.resolve('review')));
    // Memory extraction is a separate auxiliary job; it runs on the `memory`
    // route rather than borrowing the reviewer's caller.
    const memoryCaller = options.stepCaller
      ? undefined
      : this.buildCaller(this.models.resolve('memory'));

    if (autoReviewEnabled) {
      // The review model must never be the main agent's caller: sharing one
      // caller would consume main-loop steps and collapse the separation.
      this.reviewer = new AutoReviewer({
        modelCaller: reviewCaller,
        rulesOnly: reviewCaller === undefined,
        mode: this.config.autoReviewMode,
        workspaceDir
      });
    }

    // 6b. Memory evolution: model-guided when an auxiliary caller exists (a real
    //     adapter or an injected one), deterministic keyword extraction otherwise.
    this.synthesizer = new MemorySynthesizer({ modelCaller: memoryCaller });

    // 7. The loop engine is the sole tool executor.
    this.permissionGate = options.permissionGate;
    this.engine = new AgentLoopEngine({
      session: this.session,
      assembler: this.assembler,
      stepCaller: this.stepCaller,
      tools,
      reviewer: this.reviewer,
      permissionGate: this.permissionGate,
      workspaceDir,
      modelRouter: this.models,
      createStepCaller: (route) => this.buildCaller(route)
    });
  }

  private static resolveSession(params: {
    sessionId?: string;
    newSession?: boolean;
    workspaceDir: string;
    cwd: string;
  }): SessionManager {
    if (params.sessionId) {
      const resolved = resolveSessionFile(params.sessionId, params.cwd, params.workspaceDir);
      if (resolved) {
        return SessionManager.open(resolved);
      }
      return SessionManager.create({ workspaceDir: params.workspaceDir, cwd: params.cwd });
    }

    if (!params.newSession) {
      const recent = findMostRecentSession(params.cwd, params.workspaceDir);
      if (recent) {
        return SessionManager.open(recent);
      }
    }

    return SessionManager.create({ workspaceDir: params.workspaceDir, cwd: params.cwd });
  }

  private setStatus(newStatus: AgentStatus, callbacks?: RunnerCallbacks): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      callbacks?.onStatusChange?.(newStatus);
    }
  }

  public getSessionId(): string {
    return this.session.getSessionId();
  }

  public getSessionFile(): string | null {
    return this.session.getFilePath();
  }

  public getLeafId(): string | null {
    return this.session.getLeafId();
  }

  public getStatus(): AgentRunnerStatus {
    return {
      sessionId: this.session.getSessionId(),
      sessionFile: this.session.getFilePath(),
      leafId: this.session.getLeafId(),
      messageCount: this.session.buildSessionContext().length,
      state: this.status
    };
  }

  public getWorkstation(): WorkstationInfo {
    return this.assembler.promptBuilder.workstationInfo();
  }

  /**
   * Skills discoverable for this workspace (`.agents/skills/<name>/SKILL.md`),
   * with user-global skills merged in and shadowed by same-name workspace skills.
   */
  public async getSkills(): Promise<AgentSkill[]> {
    return discoverSkills(this.config.workspaceDir ?? process.cwd());
  }

  public listSessions(): SessionDescriptor[] {
    return listSessions(this.config.workspaceDir ?? process.cwd(), this.config.workspaceDir);
  }

  /** Build a caller for a route, falling back to the injected test caller. */
  private buildCaller(route: ModelRoute): StepModelCaller {
    if (this.callerFactory) {
      return this.callerFactory(route);
    }
    if (this.stepCaller) {
      return this.stepCaller;
    }
    throw new Error('AgentRunner has no step caller configured for route ' + route.model);
  }

  /**
   * Change the model for a role at runtime.
   *
   * `main` is what the chat UI's model selector drives. The new caller is built
   * eagerly but the running turn keeps the caller it started with, so switching
   * models mid-turn takes effect on the NEXT turn rather than corrupting the
   * turn already in flight.
   */
  public setModel(role: ModelRole, route: Partial<ModelRoute>): void {
    this.models.setRoute(role, route);

    if (role === 'main') {
      this.stepCaller = this.buildCaller(this.models.resolve('main'));
      this.engine.stepCaller = this.stepCaller;
    } else if (role === 'review' && this.reviewer && this.callerFactory) {
      // Rebuild rather than patch `modelCaller`: `rulesOnly` is readonly and was
      // decided at construction, so a runner that started rule-only would ignore
      // an assigned caller. Requires `callerFactory` — with only an injected
      // caller there is no distinct model to build, and reusing the main caller
      // would let the main model approve its own actions, so the reviewer stays
      // rule-only instead.
      const rebuilt = new AutoReviewer({
        modelCaller: this.buildCaller(this.models.resolve('review')),
        mode: this.reviewer.mode,
        workspaceDir: this.config.workspaceDir ?? process.cwd()
      });
      this.reviewer = rebuilt;
      this.engine.reviewer = rebuilt;
    } else if (role === 'memory') {
      // The synthesizer holds its caller privately, so swapping the memory model
      // means rebuilding it rather than mutating it from the outside.
      this.synthesizer = new MemorySynthesizer({
        modelCaller: this.buildCaller(this.models.resolve('memory'))
      });
    }
  }

  /** Every role's effective route, including the effort-scaled token budget. */
  public getModelRoutes(): Record<ModelRole, ModelRoute> {
    return this.models.listRoutes();
  }

  /** Switch to another session by file path, file name, session id, or id prefix. */
  public loadSession(reference: string): SessionManager {
    const workspaceDir = this.config.workspaceDir ?? process.cwd();
    const resolved = resolveSessionFile(reference, workspaceDir, workspaceDir);
    if (!resolved) {
      throw new Error(`Session '${reference}' not found in workspace ${workspaceDir}`);
    }

    this.session.close();
    this.session = SessionManager.open(resolved);
    this.assembler.session = this.session;
    this.engine.session = this.session;
    return this.session;
  }

  public createSession(title?: string): SessionManager {
    const workspaceDir = this.config.workspaceDir ?? process.cwd();
    this.session.close();
    this.session = SessionManager.create({ workspaceDir, cwd: workspaceDir, title });
    this.assembler.session = this.session;
    this.engine.session = this.session;
    return this.session;
  }

  public getMessages(limit?: number): ContextMessage[] {
    return this.session.getMessages(limit);
  }

  public getHistory(query?: string, limit?: number): PromptHistoryEntry[] {
    return this.history.search(this.config.workspaceDir ?? process.cwd(), query, limit);
  }

  /**
   * Mine the active branch for durable knowledge and persist it to `MEMORY.md`
   * (project facts) and `USER.md` (user preferences). `SOUL.md` is never touched.
   *
   * Callable at any time — typically on session close or from a shell command.
   * Facts already present in either file are skipped, so repeated calls over the
   * same conversation are idempotent.
   *
   * `modelCaller` overrides the runner's auxiliary caller for this one call;
   * without any caller (or when it fails) extraction falls back to the
   * deterministic keyword pass.
   */
  public async extractMemory(
    options: { modelCaller?: StepModelCaller; messages?: ContextMessage[] } = {}
  ): Promise<MemoryUpdateResult> {
    return this.synthesizer.extractAndApplyUpdates({
      messages: options.messages ?? this.getMessages(),
      memoryDir: this.config.memoryDir,
      modelCaller: options.modelCaller
    });
  }

  public abort(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.status = 'idle';
  }

  /** `/clear`: append a `reset_boundary` so the active branch restarts empty. */
  public reset(): void {
    this.abort();
    this.session.clear();
    this.emotion = createInitialEmotion();
    this.status = 'idle';
  }

  public close(): void {
    this.abort();
    this.session.close();
    this.history.close();
  }

  /**
   * Run one turn.
   *
   * `options.model` / `options.modelRoute` pin this turn to a specific model
   * without changing the runner's configured routes, so a one-off override (for
   * example a chat message sent with a different model selected) does not leak
   * into the next turn.
   */
  public async run(
    prompt: string,
    callbacks?: RunnerCallbacks,
    options: { model?: string; modelRoute?: Partial<ModelRoute> } = {}
  ): Promise<string> {
    if (this.status !== 'idle') {
      this.abort();
    }

    const workspaceDir = this.config.workspaceDir ?? process.cwd();

    this.setStatus('running', callbacks);
    this.currentAbortController = new AbortController();
    const signal = this.currentAbortController.signal;

    // Prompt recall is recorded before the turn so it survives an aborted run.
    this.history.append(prompt, workspaceDir, this.session.getSessionId());
    this.emotion = updateEmotionOnInteraction(this.emotion, { arousalDelta: 0.1 });

    try {
      this.setStatus('thinking', callbacks);

      const loopResult = await this.engine.run(prompt, {
        maxSteps: this.config.maxSteps,
        signal,
        model: options.model,
        modelRoute: options.modelRoute,
        callbacks: {
          onStepStart: (stepIndex) => {
            callbacks?.onStepStart?.(stepIndex);
            this.setStatus('thinking', callbacks);
          },
          onChunk: (chunk) => {
            this.setStatus('streaming', callbacks);
            callbacks?.onChunk?.(chunk);
          },
          onReasoning: (chunk) => {
            callbacks?.onReasoning?.(chunk);
          },
          onToolCall: (name, args) => {
            this.setStatus('tool_calling', callbacks);
            callbacks?.onToolCall?.(name, args);
          },
          onToolResult: (name, result, isError) => {
            this.emotion = updateEmotionOnInteraction(this.emotion, {
              valenceDelta: isError ? -0.2 : 0.05,
              fatigueDelta: 0.05
            });
            callbacks?.onToolResult?.(name, result, isError);
          },
          onError: (err) => {
            this.emotion = updateEmotionOnInteraction(this.emotion, { valenceDelta: -0.3 });
            callbacks?.onError?.(err);
          }
        }
      });

      this.emotion = decayEmotion(this.emotion);

      if (loopResult.aborted || signal.aborted) {
        this.setStatus('aborted', callbacks);
        this.setStatus('idle', callbacks);
        return loopResult.finalText || '[Task aborted by user]';
      }

      this.setStatus('completed', callbacks);
      this.setStatus('idle', callbacks);
      return loopResult.finalText;
    } catch (err: unknown) {
      const isAbort =
        signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')));

      if (isAbort) {
        this.setStatus('aborted', callbacks);
        this.setStatus('idle', callbacks);
        return '[Task aborted by user]';
      }

      this.setStatus('error', callbacks);
      this.setStatus('idle', callbacks);

      const errorObj = err instanceof Error ? err : new Error(String(err));
      callbacks?.onError?.(errorObj);
      throw errorObj;
    } finally {
      this.currentAbortController = null;
    }
  }
}
