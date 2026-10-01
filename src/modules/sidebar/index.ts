export { default as Sidebar } from '@/modules/sidebar/Sidebar';
export { default as ResidentMark } from '@/modules/sidebar/ResidentMark';
// Browser-local "show hidden sessions" preference, read by project-workspace when it loads session pages.
export { readShownHiddenProjectIds, writeShownHiddenProjectIds } from '@/modules/sidebar/utils/sidebarStoredPreferences';
