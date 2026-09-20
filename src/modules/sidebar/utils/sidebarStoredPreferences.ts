import type { ProjectSortOrder } from '@/shared/types';
import { readUserPreference } from '@/shared/userSettings';

export const readProjectSortOrder = (): ProjectSortOrder => (
  readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name'
);

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const SHOWN_HIDDEN_PROJECTS_STORAGE_KEY = 'sidebarShownHiddenSessionProjects';

/**
 * Reads the ids of projects whose name-filtered sessions this browser shows temporarily.
 * Browser-local on purpose: it never changes the project's stored rules.
 */
export const readShownHiddenProjectIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOWN_HIDDEN_PROJECTS_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value).trim()).filter((value) => value.length > 0)
      : [];
  } catch {
    return [];
  }
};

/** Persists the temporary "show hidden sessions" project ids; an empty list removes the key. */
export const writeShownHiddenProjectIds = (projectIds: Iterable<string>) => {
  try {
    const ids = [...projectIds];
    if (ids.length === 0) {
      localStorage.removeItem(SHOWN_HIDDEN_PROJECTS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SHOWN_HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};
