import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, ChevronDown, type LucideIcon } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogContent, DialogTitle, DialogTrigger, Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins,PluginIcon } from '@/modules/plugins';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

// The icon class differs per kind, so the shared renderer takes both rather than
// one class that would have to be wrong for one of the two.
const BUILT_IN_ICON_CLASS = 'h-3.5 w-3.5 shrink-0';
const PLUGIN_ICON_CLASS = 'flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full';

type BuiltInTabSource = {
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  label: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type WorkspaceTabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTabSource[] = [
  { id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
  { id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const BROWSER_TAB: BuiltInTabSource = {
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTabSource = {
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/**
 * The single source of truth for the workspace view list: the four built-in tabs,
 * the conditionally enabled Browser/Tasks tabs and every enabled plugin tab, each
 * carrying its already-translated label. Both the desktop pill bar and the mobile
 * selector read it, so neither can drift into a second copy of the list.
 */
function useWorkspaceTabDefinitions({ shouldShowTasksTab, shouldShowBrowserTab }: {
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
}): { tabs: WorkspaceTabDefinition[]; builtInCount: number } {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInSources = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const builtInTabs: BuiltInTab[] = builtInSources.map((tab) => ({
    kind: 'builtin',
    id: tab.id,
    label: t(tab.labelKey),
    icon: tab.icon,
  }));

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  return { tabs: [...builtInTabs, ...pluginTabs], builtInCount: builtInTabs.length };
}

/** Renders a workspace view's icon, built-in or plugin-supplied; used by both workspace view lists. */
function WorkspaceTabIcon({ tab, strokeWidth }: { tab: WorkspaceTabDefinition; strokeWidth?: number }) {
  if (tab.kind === 'plugin') {
    return <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className={PLUGIN_ICON_CLASS} />;
  }

  return <tab.icon className={BUILT_IN_ICON_CLASS} strokeWidth={strokeWidth} />;
}

/** Rendered by WorkspaceHeader on desktop as the scrollable horizontal workspace tab bar. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { tabs, builtInCount } = useWorkspaceTabDefinitions({ shouldShowTasksTab, shouldShowBrowserTab });

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInCount && tabs.length > builtInCount && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={tab.label} position="bottom">
              <Pill
                role="tab"
                aria-label={tab.label}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className="h-8 max-w-44 px-2.5 py-[5px]"
              >
                <WorkspaceTabIcon tab={tab} strokeWidth={isActive ? 2.2 : 1.8} />
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate md:max-w-36 lg:inline`}>
                  {tab.label}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}

/**
 * Rendered by WorkspaceHeader on mobile, where the header is a single row: it shows
 * the active workspace and opens a bottom dialog listing every workspace view —
 * including each enabled plugin, which must stay reachable when the pill bar is
 * collapsed away.
 */
export function CollapsedWorkspaceSelector({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { tabs } = useWorkspaceTabDefinitions({ shouldShowTasksTab, shouldShowBrowserTab });

  // Whether the workspace picker is open. The open state cannot be derived: the
  // trigger that has to report `aria-expanded` is rendered outside DialogContent,
  // so the dialog is controlled from here.
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const titleId = useId();

  const activeTabDefinition = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  const selectWorkspace = (id: AppTab) => {
    setActiveTab(id);
    setIsPickerOpen(false);
  };

  return (
    <Dialog open={isPickerOpen} onOpenChange={setIsPickerOpen}>
      <DialogTrigger
        aria-haspopup="dialog"
        aria-expanded={isPickerOpen}
        className="flex h-8 min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <WorkspaceTabIcon tab={activeTabDefinition} strokeWidth={2} />
        <span className="truncate">{activeTabDefinition.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </DialogTrigger>

      <DialogContent
        aria-labelledby={titleId}
        className="bottom-0 left-0 top-auto max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-xl pb-safe-area-inset-bottom"
      >
        <DialogTitle id={titleId} className="not-sr-only px-4 pb-2 pt-4 text-sm font-semibold">
          {t('tabs.views', { defaultValue: 'Workspace views' })}
        </DialogTitle>
        <div className="scrollbar-hide max-h-[70vh] overflow-y-auto px-2 pb-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={tab.id === activeTab ? 'true' : undefined}
              onClick={() => selectWorkspace(tab.id)}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <WorkspaceTabIcon tab={tab} strokeWidth={2} />
              <span className="min-w-0 truncate">{tab.label}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
