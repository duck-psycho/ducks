import { DEFAULT_THEME } from './themes.js';
import type { ThemeId } from './themes.js';

export type AgentStatus =
  'starting' | 'running' | 'exited' | 'error' | 'stopped';

export type AgentActivity = 'working' | 'idle' | 'waiting';

export type Profile = {
  id: string;
  name: string;
  executable: string;
  args: string[];
};

export type AgentDefinition = {
  id: string;
  name: string;
  profileId: string;
  kind?: 'shell';
};

export type Place = {
  id: string;
  name: string;
  directory: string;
  agents: AgentDefinition[];
  activeAgentId: string | null;
  autoName?: boolean;
};

export type Config = {
  version: 1;
  theme: ThemeId;
  profiles: Profile[];
  places: Place[];
  activePlaceId: string | null;
};

export function defaultConfig(): Config {
  return {
    version: 1,
    theme: DEFAULT_THEME.id,
    profiles: [
      { id: 'codex', name: 'Codex', executable: 'codex', args: [] },
      { id: 'claude', name: 'Claude Code', executable: 'claude', args: [] },
    ],
    places: [],
    activePlaceId: null,
  };
}
