import type { Bot, ComputerState, EngineInfo, LibraryFile, LibrarySkill, Memory, Project, ProjectSkill, Routine, Skill, Subscription, Task, Toolkit } from '@shared/types';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string }

/** The fields a person sets on a project (everything else is derived by the server). */
export interface ProjectDraft { name: string; description: string; folder: string; instructions: string; harness: string; harnessModel: string | null }

/** One git worktree of a project's folder (server/src/code-workspace.ts). */
export interface Worktree { path: string; branch: string | null; head: string; detached: boolean; bare: boolean; main: boolean }

/** An agent program a bot can run on (Hermes, or an ACP harness such as Codex). */
export interface HarnessOption { id: string; name: string; subscription: string; installed: boolean }

/** The models an ACP harness offers with its sign-in on the computer. */
export interface HarnessModels { models: { value: string; name: string }[]; current: string | null }

/** One short real turn through a bot's saved settings (see server/src/engine-check.ts). */
export interface EngineCheck { ok: boolean; status: number; ms: number; via: string; reply?: string; error?: string }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
}

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'avatarImage' | 'effort' | 'mode'>>;

export const configApi = {
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  projects: () => req<{ projects: Project[] }>('GET', '/projects'),
  project: (id: string) => req<{ project: Project; skills: ProjectSkill[] }>('GET', `/projects/${id}`),
  createProject: (p: ProjectDraft) => req<{ project: Project }>('POST', '/projects', p),
  updateProject: (id: string, p: Partial<ProjectDraft>) => req<{ project: Project }>('PATCH', `/projects/${id}`, p),
  deleteProject: (id: string) => req<{ ok: true }>('DELETE', `/projects/${id}`),
  addProjectSkill: (id: string, s: Pick<ProjectSkill, 'name' | 'description' | 'body'>) => req<{ skill: ProjectSkill }>('POST', `/projects/${id}/skills`, s),
  updateProjectSkill: (skillId: string, s: Partial<Pick<ProjectSkill, 'name' | 'description' | 'body'>>) => req<{ skill: ProjectSkill }>('PATCH', `/projects/skills/${skillId}`, s),
  deleteProjectSkill: (skillId: string) => req<{ ok: true }>('DELETE', `/projects/skills/${skillId}`),
  /** Registers the project's folder with the Code workspace (T3) on the server, so it opens there with a terminal. */
  openProjectInCode: (id: string) => req<{ ok: true; folder: string; already: boolean }>('POST', `/projects/${id}/open-code`),

  /** The git worktrees of the project's folder (read-only). `repo: false` when the folder is not a git repository. */
  projectWorktrees: (id: string) => req<{ folder: string; repo: boolean; worktrees: Worktree[] }>('GET', `/projects/${id}/worktrees`),

  /** Whether the computer's GitHub command line (gh) is signed in, and as whom. */
  githubStatus: () => req<{ installed: boolean; signedIn: boolean; account: string | null }>('GET', '/workspace/github'),
  githubRepos: () => req<{ repos: { nameWithOwner: string; description: string; isPrivate: boolean; updatedAt: string }[] }>('GET', '/workspace/github/repos'),
  /** Opens GitHub's sign-in in a terminal on the bot's screen. */
  githubLogin: (botId: string) => req<{ ok: true }>('POST', '/workspace/github/login', { botId }),
  /** Starts signing the computer in to GitHub from the app: the one-time code to confirm at `url`. */
  githubDeviceStart: () => req<{ code: string; url: string }>('POST', '/workspace/github/device'),
  githubDeviceStatus: () => req<{ state: 'idle' } | { state: 'waiting'; code: string; url: string } | { state: 'done'; account: string | null } | { state: 'error'; error: string }>('GET', '/workspace/github/device'),
  githubDeviceCancel: () => req<{ ok: true }>('DELETE', '/workspace/github/device'),
  /** The repository's folder in Projects: the existing checkout, or a fresh clone. */
  openRepo: (repo: string) => req<{ folder: string; existing: boolean }>('POST', '/workspace/github/open', { repo }),
  newFolder: (name: string) => req<{ folder: string }>('POST', '/workspace/folder', { name }),
  cloneRepo: (repo: string, name?: string) => req<{ folder: string }>('POST', '/workspace/clone', { repo, ...(name ? { name } : {}) }),
  newWorktree: (folder: string, branch: string, base?: string) => req<{ folder: string }>('POST', '/workspace/worktree', { folder, branch, ...(base ? { base } : {}) }),
  /** Opens a file a bot linked to (an absolute path on the computer) on that bot's screen. */
  showOnScreen: (botId: string, path: string) => req<{ ok: true; via: 'browser' | 'terminal'; path: string }>('POST', '/workspace/show', { botId, path }),
  /** OpenCode (a terminal agent) or a shell, in the folder, on the bot's screen. */
  openTerminal: (botId: string, folder: string, agent: 'opencode' | 'shell' = 'opencode') => req<{ ok: true; folder: string }>('POST', '/workspace/terminal', { botId, folder, agent }),

  /** The skills already on the computer: Zo's and the primary Hermes agent's. Read-only. */
  skillLibrary: () => req<{ skills: LibrarySkill[] }>('GET', '/launch/skills'),
  /**
   * Starts work on a bot: records the request in its chat and hands it the brief. A project is optional; without
   * one, `folder` is just told to the bot. `skills` are ids from skillLibrary (at most 8), never skill text.
   */
  launch: (p: { botId: string; prompt: string; projectId?: string | null; folder?: string; skills?: string[] }) => req<{ ok: true; botId: string }>('POST', '/launch/start', p),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  subscriptions: () => req<{ subscriptions: Subscription[]; local: boolean }>('GET', '/computer/subscriptions'),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
  /** Tells the bot the person has stopped driving its screen. */
  handback: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/handback`),

  engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
  setEngine: (botId: string, p: { provider?: string | null; model?: string | null }) => req<{ engine: EngineInfo }>('PATCH', `/bots/${botId}/engine`, p),
  /** Opens the provider's sign-in flow in a terminal on the bot's screen. */
  engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
  claudeLoginStart: (botId: string) => req<{ url: string }>('POST', `/bots/${botId}/engine/claude-login`),
  claudeLoginFinish: (botId: string, code: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/claude-login/finish`, { code }),
  claudeLoginCancel: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}/engine/claude-login`),
  harnesses: () => req<{ harnesses: HarnessOption[] }>('GET', '/harnesses'),
  checkEngine: (botId: string) => req<{ check: EngineCheck }>('POST', `/bots/${botId}/engine/check`),
  setHarness: (botId: string, harness: string, model?: string | null) => req<{ ok: true; harness: string; model: string | null }>('PATCH', `/bots/${botId}/harness`, { harness, ...(model !== undefined ? { model } : {}) }),
  harnessModels: (harness: string) => req<HarnessModels>('GET', `/harnesses/${harness}/models`),
  restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private screen the agent runs for itself, so its computer work shows on the screen in the app. */
  stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};
