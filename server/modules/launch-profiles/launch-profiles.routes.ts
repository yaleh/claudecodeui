import { randomUUID } from 'node:crypto';

import express from 'express';

import type { LaunchProfileInput } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import type { launchProfilesService } from './launch-profiles.service.js';

type LaunchProfilesService = typeof launchProfilesService;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required`, { code: 'LAUNCH_PROFILE_INVALID', statusCode: 400 });
  }
  return value.trim();
}

/** Converts a request body to the service's typed input, rejecting malformed fields with 400. */
function parseProfileBody(body: unknown): Omit<LaunchProfileInput, 'id'> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const config = raw.config ?? {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new AppError('config must be an object', { code: 'LAUNCH_PROFILE_INVALID', statusCode: 400 });
  }
  return {
    provider: requireString(raw.provider, 'provider'),
    name: requireString(raw.name, 'name'),
    description: typeof raw.description === 'string' ? raw.description : null,
    deployment: typeof raw.deployment === 'string' && raw.deployment ? raw.deployment : 'gateway',
    isDefault: raw.isDefault === true,
    config: config as Record<string, unknown>,
    ...(typeof raw.sortOrder === 'number' ? { sortOrder: raw.sortOrder } : {}),
  };
}

/** Creates thin launch-profile transport handlers around the application service. */
export function createLaunchProfilesRouter(service: LaunchProfilesService): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request, res: express.Response) => unknown) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { operation(req, res); } catch (error) { next(error); }
    };

  router.post('/', respond((req, res) => {
    const input = parseProfileBody(req.body);
    const id = typeof req.body?.id === 'string' && req.body.id.trim() ? req.body.id.trim() : randomUUID();
    service.createProfile({ ...input, id });
    res.status(201).json(service.getProfile(id));
  }));
  router.get('/', respond((req, res) => {
    const provider = typeof req.query.provider === 'string' && req.query.provider ? req.query.provider : undefined;
    res.json(service.listProfiles(provider));
  }));
  router.get('/:id', respond((req, res) => { res.json(service.getProfile(String(req.params.id))); }));
  router.put('/:id', respond((req, res) => {
    const id = String(req.params.id);
    service.updateProfile(id, parseProfileBody(req.body));
    res.json(service.getProfile(id));
  }));
  router.delete('/:id', respond((req, res) => {
    service.deleteProfile(String(req.params.id));
    res.status(204).end();
  }));
  return router;
}
