import { useEffect } from 'react';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { CodeView } from './components/CodeView';
import { MacroView } from './components/MacroView';
import { BuildflowView } from './components/BuildflowView';
import { HqView, useActiveBotCount } from './components/HqView';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { ConnectAppsModal } from './components/modals/ConnectAppsModal';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { SpacesModal } from './components/modals/SpacesModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { GnoesisWork } from './components/gnoesis/GnoesisWork';
import { TeamsView } from './components/TeamsView';
import { RevOptView } from './components/RevOptView';
import { TradingView } from './components/TradingView';
import { useConfigUI } from './configStore';

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const view = useConfigUI((s) => s.view);
  const { needs } = useActiveBotCount();

  // "(2) GnoesisBots" in the tab title: a bot waiting on you is visible even from another tab.
  useEffect(() => {
    const base = 'GnoesisBots';
    document.title = needs > 0 ? `(${needs}) ${base}` : base;
    return () => { document.title = base; };
  }, [needs]);

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'grokbot-connected') return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); st.set({ sidebarCollapsed: !st.sidebarCollapsed }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // GnoesisWork (Work) takes the whole window, with its own sidebar and a way back to Bot HQ.
  if (view === 'tasks') {
    return (
      <>
        <GnoesisWork />
        {modal === 'search' && <SearchModal />}
        {modal === 'apps' && <ConnectAppsModal />}
        {modal === 'spaces' && <SpacesModal />}
        {modal === 'create' && <CreateBotModal />}
        {viewerOpen && <ComputerViewer />}
        <ConfigLayer />
      </>
    );
  }

  return (
    <div className={`app${collapsed ? ' is-sidebar-collapsed' : ''}${detailsOpen && hasBot && view === 'chat' ? ' has-details' : ''}`}>
      <Sidebar />
      {view === 'code' ? <CodeView /> : view === 'teams' ? <TeamsView /> : view === 'revopt' ? <RevOptView /> : view === 'macro' ? <MacroView /> : view === 'buildflow' ? <BuildflowView /> : view === 'trading' ? <TradingView /> : view === 'hq' ? <HqView /> : <ChatView />}
      {detailsOpen && hasBot && view === 'chat' && <DetailsPanel />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'spaces' && <SpacesModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  if (!authChecked) return <div className="boot" />;
  return user ? <Shell /> : <SignIn />;
}
