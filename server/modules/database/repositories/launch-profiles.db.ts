import { getConnection } from '@/modules/database/connection.js';

export type LaunchProfileRow = {
  id: string;
  name: string;
  config_json: string;
};

/** Launch-profile persistence consumed by the launch-profiles module. Stores rows verbatim; validation lives in the service. */
export const launchProfilesDb = {
  get(id: string): LaunchProfileRow | null {
    const row = getConnection()
      .prepare('SELECT id, name, config_json FROM launch_profiles WHERE id = ?')
      .get(id) as LaunchProfileRow | undefined;
    return row ?? null;
  },

  insert(id: string, name: string, configJson: string): void {
    getConnection()
      .prepare('INSERT INTO launch_profiles (id, name, config_json) VALUES (?, ?, ?)')
      .run(id, name, configJson);
  },

  update(id: string, name: string, configJson: string): boolean {
    const result = getConnection()
      .prepare('UPDATE launch_profiles SET name = ?, config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(name, configJson, id);
    return result.changes > 0;
  },
};
