import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  fetchConfiguration,
  fetchConfigurationValue,
  fetchCurrentUser,
  normaliseConfigKey,
  registerAdminTools,
  setConfigurationValue,
  updatePreference,
} from '../tools/admin.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

describe('normaliseConfigKey', () => {
  it('adds the configuration prefix when it is missing', () => {
    // Passing the bare name reads nothing rather than failing, which is the worst kind of wrong.
    expect(normaliseConfigKey('allow_webhooks')).toBe('configuration.allow_webhooks');
  });

  it('leaves an already-prefixed key alone', () => {
    expect(normaliseConfigKey('configuration.allow_webhooks')).toBe('configuration.allow_webhooks');
  });
});

describe('configuration', () => {
  const entries = [
    { title: 'configuration.single_user_mode', value: true, editable: true },
    { title: 'configuration.allow_webhooks', value: false, editable: true },
    { title: 'search.operators', value: 'x'.repeat(17_000), editable: false },
    { title: 'firefly.languages', value: { en: 'English' }, editable: false },
  ];

  it('returns only the editable settings by default', async () => {
    // The full response is ~40 000 characters, of which the search-operator catalogue alone is
    // 17 000. Nobody asking for "the configuration" means that.
    mockClient.get = vi.fn().mockResolvedValueOnce(entries);
    const result = (await fetchConfiguration(mockClient)) as Array<{ title: string }>;
    expect(result.map((e) => e.title)).toEqual(['configuration.single_user_mode', 'configuration.allow_webhooks']);
  });

  it('returns everything when reference data is asked for', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(entries);
    const result = (await fetchConfiguration(mockClient, { include_reference_data: true })) as unknown[];
    expect(result).toHaveLength(4);
  });

  it('passes a non-array response through untouched', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce({ unexpected: true });
    expect(await fetchConfiguration(mockClient)).toEqual({ unexpected: true });
  });

  it('reads and writes a value by its prefixed key', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce({ data: {} });
    await fetchConfigurationValue(mockClient, 'allow_webhooks');
    expect(mockClient.get).toHaveBeenCalledWith('/configuration/configuration.allow_webhooks');

    mockClient.put = vi.fn().mockResolvedValueOnce({ data: {} });
    await setConfigurationValue(mockClient, 'allow_webhooks', true);
    expect(mockClient.put).toHaveBeenCalledWith('/configuration/configuration.allow_webhooks', { value: true });
  });
});

describe('preferences and current user', () => {
  it('wraps a preference update in the data envelope the API expects', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce({ data: { id: '1', type: 'preferences', attributes: {} } });
    await updatePreference(mockClient, 'language', 'fr_FR');
    expect(mockClient.put).toHaveBeenCalledWith('/preferences/language', { data: 'fr_FR' });
  });

  it('reads the authenticated user', async () => {
    mockClient.get = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: '1', type: 'users', attributes: { email: 'a@b.test', role: 'owner' } } });
    expect(await fetchCurrentUser(mockClient)).toMatchObject({ email: 'a@b.test', role: 'owner' });
  });
});

describe('admin tool descriptions', () => {
  it('say that the owner role is needed, so a 403 is not a mystery', () => {
    const { server, toolConfigs } = createMockServer();
    registerAdminTools(server, mockClient);
    for (const name of ['get_users', 'create_user', 'get_user_groups', 'set_configuration_value']) {
      expect(toolConfigs.get(name).description, name).toMatch(/owner role/i);
    }
  });

  it('warn that deleting a user deletes their financial records', () => {
    const { server, toolConfigs } = createMockServer();
    registerAdminTools(server, mockClient);
    expect(toolConfigs.get('delete_user').description).toMatch(/every financial record they own/i);
    expect(toolConfigs.get('delete_user').annotations.destructiveHint).toBe(true);
  });

  it('point at set_configuration_value as the way to enable webhooks', () => {
    const { server, toolConfigs } = createMockServer();
    registerAdminTools(server, mockClient);
    // The 404 a disabled webhook surface returns is otherwise very hard to interpret.
    expect(toolConfigs.get('set_configuration_value').description).toMatch(/allow_webhooks/);
  });
});
