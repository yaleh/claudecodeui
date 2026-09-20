import { getConnection } from '@/modules/database/connection.js';

/** A persisted launch profile; `config` is the parsed, non-secret `config_json`. */
export type LaunchProfileRecord = {
  id: string;
  provider: string;
  name: string;
  description: string | null;
  deployment: string;
  isDefault: boolean;
  config: Record<string, unknown>;
  sortOrder: number;
};

/** Fields required to create a profile; `config` must already be secret-free. */
export type LaunchProfileInput = Omit<LaunchProfileRecord, 'sortOrder'> & { sortOrder?: number };

type LaunchProfileRow = {
  id: string;
  provider: string;
  name: string;
  description: string | null;
  deployment: string;
  is_default: number;
  config_json: string;
  sort_order: number;
};

function toRecord(row: LaunchProfileRow): LaunchProfileRecord {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    description: row.description,
    deployment: row.deployment,
    isDefault: Boolean(row.is_default),
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    sortOrder: row.sort_order,
  };
}

// launchProfilesDb: used by the Launch Profiles service to persist profile rows.
export const launchProfilesDb = {
  create(input: LaunchProfileInput): void {
    getConnection()
      .prepare(
        `INSERT INTO launch_profiles (id, provider, name, description, deployment, is_default, config_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.provider,
        input.name,
        input.description,
        input.deployment,
        input.isDefault ? 1 : 0,
        JSON.stringify(input.config),
        input.sortOrder ?? 0,
      );
  },

  get(id: string): LaunchProfileRecord | null {
    const row = getConnection().prepare('SELECT * FROM launch_profiles WHERE id = ?').get(id) as
      | LaunchProfileRow
      | undefined;
    return row ? toRecord(row) : null;
  },

  list(provider?: string): LaunchProfileRecord[] {
    const db = getConnection();
    const rows = (provider
      ? db.prepare('SELECT * FROM launch_profiles WHERE provider = ? ORDER BY sort_order, name').all(provider)
      : db.prepare('SELECT * FROM launch_profiles ORDER BY provider, sort_order, name').all()) as LaunchProfileRow[];
    return rows.map(toRecord);
  },

  update(id: string, input: Omit<LaunchProfileInput, 'id'>): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE launch_profiles
         SET provider = ?, name = ?, description = ?, deployment = ?, is_default = ?, config_json = ?,
             sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        input.provider,
        input.name,
        input.description,
        input.deployment,
        input.isDefault ? 1 : 0,
        JSON.stringify(input.config),
        input.sortOrder ?? 0,
        id,
      );
    return result.changes > 0;
  },

  delete(id: string): boolean {
    return getConnection().prepare('DELETE FROM launch_profiles WHERE id = ?').run(id).changes > 0;
  },
};
