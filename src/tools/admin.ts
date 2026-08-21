/**
 * Administration: users, user groups, instance configuration and preferences.
 *
 * These need the owner role. An ordinary personal access token gets 403 on most of them, which
 * `formatError` explains rather than reporting as a bare status code. The group is excluded from
 * every preset except `full`, because on a single-user instance — which is what Firefly III mostly
 * is — they are tool definitions occupying context to no purpose.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FireflyClient } from '../client.js';
import {
  type JsonApiListResponse,
  type JsonApiSingleResponse,
  type UnwrappedList,
  type UnwrappedSingle,
  unwrapList,
  unwrapSingle,
} from '../transform.js';
import { DELETE_ANNOTATIONS, READ_ANNOTATIONS, UPDATE_ANNOTATIONS, WRITE_ANNOTATIONS } from './_annotations.js';
import { defineTool } from './_helpers.js';

const enc = encodeURIComponent;

const pagination = (params: { page?: number; limit?: number }) => ({ page: params.page, limit: params.limit });

// ── Users ─────────────────────────────────────────────────────────────────────

export async function fetchUsers(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  return unwrapList(await client.get<JsonApiListResponse>('/users', pagination(params)));
}

export async function fetchUser(client: FireflyClient, id: string): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/users/${enc(id)}`));
}

export async function createUser(
  client: FireflyClient,
  params: { email: string; blocked?: boolean; blocked_code?: string; role?: string },
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.post<JsonApiSingleResponse>('/users', params));
}

export async function updateUser(
  client: FireflyClient,
  id: string,
  params: { email?: string; blocked?: boolean; blocked_code?: string; role?: string },
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.put<JsonApiSingleResponse>(`/users/${enc(id)}`, params));
}

export async function deleteUser(client: FireflyClient, id: string): Promise<{ deleted: true; id: string }> {
  await client.delete(`/users/${enc(id)}`);
  return { deleted: true, id };
}

// ── User groups (administrations) ──────────────────────────────────────────────

export async function fetchUserGroups(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  return unwrapList(await client.get<JsonApiListResponse>('/user-groups', pagination(params)));
}

export async function fetchUserGroup(client: FireflyClient, id: string): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/user-groups/${enc(id)}`));
}

export async function updateUserGroup(
  client: FireflyClient,
  id: string,
  params: { title?: string; primary_currency_id?: string; primary_currency_code?: string },
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.put<JsonApiSingleResponse>(`/user-groups/${enc(id)}`, params));
}

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Instance configuration values.
 *
 * Keys carry a `configuration.` prefix — `configuration.allow_webhooks`, not `allow_webhooks`. Passing
 * the bare name silently reads nothing, so the tools normalise it.
 */
interface ConfigurationEntry {
  title?: string;
  value?: unknown;
  editable?: boolean;
}

/**
 * Instance configuration.
 *
 * The endpoint returns two quite different things under one roof: the ~10 editable
 * `configuration.*` settings, and reference data the UI needs — the search-operator catalogue alone
 * is 17 000 characters, and the whole response is about 40 000, roughly 10 000 tokens. Someone asking
 * for "the configuration" wants the settings, so reference data is excluded unless requested.
 */
export async function fetchConfiguration(
  client: FireflyClient,
  options: { include_reference_data?: boolean } = {},
): Promise<unknown> {
  const entries = await client.get<ConfigurationEntry[]>('/configuration');
  if (options.include_reference_data || !Array.isArray(entries)) return entries;
  return entries.filter((entry) => typeof entry.title === 'string' && entry.title.startsWith('configuration.'));
}

/** Adds the `configuration.` prefix when the caller left it off. */
export function normaliseConfigKey(name: string): string {
  return name.startsWith('configuration.') ? name : `configuration.${name}`;
}

export async function fetchConfigurationValue(client: FireflyClient, name: string): Promise<unknown> {
  return client.get(`/configuration/${enc(normaliseConfigKey(name))}`);
}

export async function setConfigurationValue(client: FireflyClient, name: string, value: unknown): Promise<unknown> {
  return client.put(`/configuration/${enc(normaliseConfigKey(name))}`, { value });
}

// ── Preferences ───────────────────────────────────────────────────────────────

export async function fetchPreferences(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  return unwrapList(await client.get<JsonApiListResponse>('/preferences', pagination(params)));
}

export async function fetchPreference(client: FireflyClient, name: string): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/preferences/${enc(name)}`));
}

export async function createPreference(
  client: FireflyClient,
  params: { name: string; data: unknown },
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.post<JsonApiSingleResponse>('/preferences', params));
}

export async function updatePreference(client: FireflyClient, name: string, data: unknown): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.put<JsonApiSingleResponse>(`/preferences/${enc(name)}`, { data }));
}

// ── About ─────────────────────────────────────────────────────────────────────

export async function fetchCurrentUser(client: FireflyClient): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>('/about/user'));
}

/**
 * Marks a batch of imported transactions as finished.
 *
 * Firefly III leaves transactions from a bulk import in an unprocessed state until this is called;
 * until then rules have not run over them and they may not appear in reports.
 */
export async function finishBatch(client: FireflyClient): Promise<{ finished: true }> {
  await client.post('/batch/finish', {});
  return { finished: true };
}

const ADMIN_HINT = ' Requires the owner role; an ordinary personal access token gets 403.';

export function registerAdminTools(server: McpServer, client: FireflyClient): void {
  const page = z.number().int().positive().optional().default(1).describe('Page number');
  const limit = z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)');
  const userId = z.string().describe('User ID — use get_users to find valid IDs');

  defineTool(
    server,
    'get_current_user',
    {
      title: 'Get Current User',
      description:
        'Get the user this token authenticates as, including their role. Worth calling first when an ' +
        'admin tool returns 403, to confirm whether the token has the owner role at all.',
      inputSchema: {},
      annotations: READ_ANNOTATIONS,
    },
    () => fetchCurrentUser(client),
  );

  defineTool(
    server,
    'finish_batch',
    {
      title: 'Finish Transaction Batch',
      description:
        'Mark a batch of imported transactions as finished. Firefly III leaves bulk-imported ' +
        'transactions unprocessed until this runs: rules have not fired over them, and they may be ' +
        'missing from reports. Call it after an import that left transactions in that state.',
      inputSchema: {},
      annotations: WRITE_ANNOTATIONS,
    },
    () => finishBatch(client),
  );

  defineTool(
    server,
    'get_users',
    {
      title: 'Get Users',
      description: `List the users on this Firefly III instance.${ADMIN_HINT}`,
      inputSchema: { page, limit },
      annotations: READ_ANNOTATIONS,
    },
    (params) => fetchUsers(client, params as { page?: number; limit?: number }),
  );

  defineTool(
    server,
    'get_user',
    {
      title: 'Get User',
      description: `Get one user by ID.${ADMIN_HINT}`,
      inputSchema: { id: userId },
      annotations: READ_ANNOTATIONS,
    },
    ({ id }) => fetchUser(client, id as string),
  );

  defineTool(
    server,
    'create_user',
    {
      title: 'Create User',
      description:
        'Create a user on this instance. They receive their own separate set of financial data.' + ADMIN_HINT,
      inputSchema: {
        email: z.string().email().describe('Email address, which is also the login'),
        blocked: z.boolean().optional().describe('Whether the account starts blocked'),
        blocked_code: z.enum(['email_changed']).optional().describe('Why the account is blocked'),
        role: z.enum(['owner', 'demo']).optional().describe('Role to grant'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createUser(client, params as Parameters<typeof createUser>[1]),
  );

  defineTool(
    server,
    'update_user',
    {
      title: 'Update User',
      description: `Update a user. Only fields provided are changed. Blocking a user locks them out.${ADMIN_HINT}`,
      inputSchema: {
        id: userId,
        email: z.string().email().optional().describe('Email address'),
        blocked: z.boolean().optional().describe('Whether the account is blocked'),
        blocked_code: z.enum(['email_changed']).optional().describe('Why the account is blocked'),
        role: z.enum(['owner', 'demo']).optional().describe('Role to grant'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => updateUser(client, id as string, params as Parameters<typeof updateUser>[2]),
  );

  defineTool(
    server,
    'delete_user',
    {
      title: 'Delete User',
      description:
        'Permanently delete a user **and every financial record they own** — accounts, transactions, ' +
        `budgets, all of it. **This action cannot be undone.** Consider blocking them instead.${ADMIN_HINT}`,
      inputSchema: { id: userId },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id }) => deleteUser(client, id as string),
  );

  defineTool(
    server,
    'get_user_groups',
    {
      title: 'Get User Groups',
      description:
        'List the administrations on this instance. An administration is a separate set of books; most ' +
        `instances have exactly one.${ADMIN_HINT}`,
      inputSchema: { page, limit },
      annotations: READ_ANNOTATIONS,
    },
    (params) => fetchUserGroups(client, params as { page?: number; limit?: number }),
  );

  defineTool(
    server,
    'get_user_group',
    {
      title: 'Get User Group',
      description: `Get one administration by ID, including its primary currency.${ADMIN_HINT}`,
      inputSchema: { id: z.string().describe('User group ID — use get_user_groups to find valid IDs') },
      annotations: READ_ANNOTATIONS,
    },
    ({ id }) => fetchUserGroup(client, id as string),
  );

  defineTool(
    server,
    'update_user_group',
    {
      title: 'Update User Group',
      description:
        'Update an administration. Changing the primary currency changes the currency every total is ' +
        `reported in — it does not convert any stored amount.${ADMIN_HINT}`,
      inputSchema: {
        id: z.string().describe('User group ID — use get_user_groups to find valid IDs'),
        title: z.string().optional().describe('Name of the administration'),
        primary_currency_code: z.string().optional().describe('Primary currency code, e.g. EUR'),
        primary_currency_id: z.string().optional().describe('Primary currency ID'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => updateUserGroup(client, id as string, params as Parameters<typeof updateUserGroup>[2]),
  );

  defineTool(
    server,
    'get_configuration',
    {
      title: 'Get Configuration',
      description:
        'Get the instance settings — single-user mode, whether webhooks are permitted, and so on. ' +
        'Reference data the web UI needs (the search-operator catalogue, language list, rule actions) ' +
        'is excluded by default: it is roughly 10 000 tokens and is never what someone means by ' +
        `"the configuration".${ADMIN_HINT}`,
      inputSchema: {
        include_reference_data: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also return the UI reference data. Large — around 10 000 tokens.'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ include_reference_data }) =>
      fetchConfiguration(client, { include_reference_data: include_reference_data as boolean | undefined }),
  );

  defineTool(
    server,
    'get_configuration_value',
    {
      title: 'Get Configuration Value',
      description:
        'Get one configuration value. The `configuration.` prefix is added for you, so both ' +
        '`allow_webhooks` and `configuration.allow_webhooks` work.',
      inputSchema: {
        name: z.string().describe('Configuration key, e.g. allow_webhooks, single_user_mode, is_demo_site'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ name }) => fetchConfigurationValue(client, name as string),
  );

  defineTool(
    server,
    'set_configuration_value',
    {
      title: 'Set Configuration Value',
      description:
        'Change one instance configuration value. This is how webhooks get switched on: set ' +
        `\`allow_webhooks\` to true, without which the whole webhook surface answers 404.${ADMIN_HINT}`,
      inputSchema: {
        name: z.string().describe('Configuration key, e.g. allow_webhooks'),
        value: z.union([z.boolean(), z.string(), z.number()]).describe('New value'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ name, value }) => setConfigurationValue(client, name as string, value),
  );

  defineTool(
    server,
    'get_preferences',
    {
      title: 'Get Preferences',
      description: "List this user's preferences — display settings, defaults, and similar.",
      inputSchema: { page, limit },
      annotations: READ_ANNOTATIONS,
    },
    (params) => fetchPreferences(client, params as { page?: number; limit?: number }),
  );

  defineTool(
    server,
    'get_preference',
    {
      title: 'Get Preference',
      description: 'Get one preference by name.',
      inputSchema: { name: z.string().describe('Preference name — use get_preferences to see what exists') },
      annotations: READ_ANNOTATIONS,
    },
    ({ name }) => fetchPreference(client, name as string),
  );

  defineTool(
    server,
    'create_preference',
    {
      title: 'Create Preference',
      description: 'Create a preference. Use update_preference to change one that already exists.',
      inputSchema: {
        name: z.string().describe('Preference name'),
        data: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).describe('Value to store'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ name, data }) => createPreference(client, { name: name as string, data }),
  );

  defineTool(
    server,
    'update_preference',
    {
      title: 'Update Preference',
      description: 'Change the value of an existing preference.',
      inputSchema: {
        name: z.string().describe('Preference name — use get_preferences to see what exists'),
        data: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).describe('New value'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ name, data }) => updatePreference(client, name as string, data),
  );
}
