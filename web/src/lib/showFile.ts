import { configApi } from './configApi';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';

/**
 * Opens a file a bot linked to on that bot's own computer, then shows that screen: the computer in the details
 * panel (top right, where it can be enlarged or made full screen), or the large view inside GnoesisWork.
 */
export async function showFileOnComputer(botId: string, path: string): Promise<void> {
  await configApi.showOnScreen(botId, path);
  const st = useStore.getState();
  if (st.selectedBotId !== botId) st.selectBot(botId);
  if (useConfigUI.getState().view === 'tasks') useStore.setState({ viewerOpen: true });
  else useStore.setState({ detailsOpen: true });
}
