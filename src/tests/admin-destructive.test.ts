import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  CONFIRMATION,
  DESTROYABLE_OBJECTS,
  destroyData,
  purgeData,
  registerAdminDestructiveTools,
} from '../tools/admin-destructive.js';
import { createMockServer } from './_helpers.js';

describe('destroy_data', () => {
  it('refuses without the exact confirmation, and calls nothing', async () => {
    const del = vi.fn();
    await expect(destroyData({ delete: del } as unknown as FireflyClient, 'transactions', 'yes')).rejects.toThrow(
      /must be exactly "DESTROY"/,
    );
    // The point of the guard is that nothing reaches the API, not that a nicer error comes back.
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a near-miss', async () => {
    const del = vi.fn();
    for (const wrong of ['destroy', 'Destroy', 'DESTROY ', '']) {
      await expect(destroyData({ delete: del } as unknown as FireflyClient, 'transactions', wrong)).rejects.toThrow();
    }
    expect(del).not.toHaveBeenCalled();
  });

  it('passes the object type as a query parameter when confirmed', async () => {
    // The spec documents no parameters for this operation; the instance answers 422 without `objects`.
    const del = vi.fn().mockResolvedValueOnce(undefined);
    const result = await destroyData({ delete: del } as unknown as FireflyClient, 'transactions', CONFIRMATION);
    expect(del).toHaveBeenCalledWith('/data/destroy', { objects: 'transactions' });
    expect(result).toEqual({ destroyed: true, objects: 'transactions' });
  });
});

describe('purge_data', () => {
  it('refuses without the exact confirmation', async () => {
    const del = vi.fn();
    await expect(purgeData({ delete: del } as unknown as FireflyClient, 'ok')).rejects.toThrow(/DESTROY/);
    expect(del).not.toHaveBeenCalled();
  });

  it('purges when confirmed', async () => {
    const del = vi.fn().mockResolvedValueOnce(undefined);
    expect(await purgeData({ delete: del } as unknown as FireflyClient, CONFIRMATION)).toEqual({ purged: true });
    expect(del).toHaveBeenCalledWith('/data/purge');
  });
});

describe('the irreversible tools', () => {
  const register = () => {
    const { server, toolConfigs, handlers } = createMockServer();
    registerAdminDestructiveTools(server, {} as FireflyClient);
    return { toolConfigs, handlers };
  };

  it('open their descriptions with the irreversibility', () => {
    const { toolConfigs } = register();
    // A caller skimming a tool list should not have to reach the end of a paragraph to learn this.
    expect(toolConfigs.get('destroy_data').description).toMatch(/^IRREVERSIBLY/);
    expect(toolConfigs.get('purge_data').description).toMatch(/^IRREVERSIBLY/);
  });

  it('are annotated destructive', () => {
    const { toolConfigs } = register();
    expect(toolConfigs.get('destroy_data').annotations.destructiveHint).toBe(true);
    expect(toolConfigs.get('purge_data').annotations.destructiveHint).toBe(true);
  });

  it('accept only the literal confirmation in their schema', () => {
    const { toolConfigs } = register();
    const schema = toolConfigs.get('destroy_data').inputSchema.confirm;
    expect(schema.safeParse('DESTROY').success).toBe(true);
    expect(schema.safeParse('destroy').success).toBe(false);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it('reject an unconfirmed call through the handler as a tool error', async () => {
    const { handlers } = register();
    const result = (await handlers.get('destroy_data')?.({ objects: 'transactions', confirm: 'nope' })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Nothing was deleted/);
  });

  it('lists object types the instance actually accepts', () => {
    // Verified against a live 6.5.5: each of these returns 204, and omitting the parameter is a 422.
    expect(DESTROYABLE_OBJECTS).toContain('transactions');
    expect(DESTROYABLE_OBJECTS).toContain('accounts');
    expect(DESTROYABLE_OBJECTS).toContain('budgets');
  });
});
