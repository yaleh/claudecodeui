import { launchProfilesDb } from '@/modules/database/index.js';
import { assertAllowedLaunchEnv } from '@/modules/launch-profiles/launch-spec.service.js';

/** Seam for the write-path env validator; tests substitute a lax one to prove the guard is load-bearing. */
export type LaunchProfilesGuards = { assertEnv: (env: Record<string, unknown>) => void };

export type LaunchProfileInput = { id: string; name: string; env?: Record<string, string> };

/** Builds the profile write service; every write validates env before touching the database. */
export function createLaunchProfilesService(
  guards: LaunchProfilesGuards = { assertEnv: assertAllowedLaunchEnv },
) {
  return {
    create(input: LaunchProfileInput): void {
      const env = input.env ?? {};
      guards.assertEnv(env);
      launchProfilesDb.insert(input.id, input.name, JSON.stringify({ env }));
    },

    update(input: LaunchProfileInput): void {
      const env = input.env ?? {};
      guards.assertEnv(env);
      if (!launchProfilesDb.update(input.id, input.name, JSON.stringify({ env }))) {
        throw new Error(`Launch profile "${input.id}" not found.`);
      }
    },
  };
}

// Consumed by the launch-profiles routes (not yet added) as the sole write entry point.
export const launchProfilesService = createLaunchProfilesService();
