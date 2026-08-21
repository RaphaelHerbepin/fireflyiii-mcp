/**
 * The two operations that can erase a Firefly III instance.
 *
 * Kept in their own group, and that group is excluded from every preset — including `full`. Someone
 * running `--preset full` is exploring what the server can do; handing them a tool that permanently
 * deletes their accounting is not a reasonable reading of that request. Reaching these requires
 * `--groups admin-destructive`, which nobody types by accident.
 *
 * Both tools require `confirm: "DESTROY"` exactly. Zod rejects anything else before the handler runs,
 * and the handler checks again: a client that skips schema validation would otherwise turn a typo
 * into an irreversible deletion.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FireflyClient } from '../client.js';
import { DELETE_ANNOTATIONS } from './_annotations.js';
import { defineTool } from './_helpers.js';

/**
 * Object types `destroy_data` accepts.
 *
 * The spec documents no parameters at all for this operation, yet the instance answers 422 without
 * `objects`. This list was read from Firefly III's own validation and checked against a live 6.5.5.
 */
export const DESTROYABLE_OBJECTS = [
  'budgets',
  'bills',
  'piggy_banks',
  'rules',
  'recurring',
  'categories',
  'tags',
  'object_groups',
  'accounts',
  'asset_accounts',
  'expense_accounts',
  'revenue_accounts',
  'liabilities',
  'transactions',
  'withdrawals',
  'deposits',
  'transfers',
  'not_assets_liabilities',
] as const;

export type DestroyableObject = (typeof DESTROYABLE_OBJECTS)[number];

export const CONFIRMATION = 'DESTROY';

export async function destroyData(
  client: FireflyClient,
  objects: DestroyableObject,
  confirm: string,
): Promise<{ destroyed: true; objects: string }> {
  // Re-checked here, not only in the schema: a client that does not validate against the published
  // schema would otherwise reach the API with whatever it sent.
  if (confirm !== CONFIRMATION) {
    throw new Error(`Refusing to destroy data: confirm must be exactly "${CONFIRMATION}". Nothing was deleted.`);
  }
  await client.delete('/data/destroy', { objects });
  return { destroyed: true, objects };
}

export async function purgeData(client: FireflyClient, confirm: string): Promise<{ purged: true }> {
  if (confirm !== CONFIRMATION) {
    throw new Error(`Refusing to purge data: confirm must be exactly "${CONFIRMATION}". Nothing was deleted.`);
  }
  await client.delete('/data/purge');
  return { purged: true };
}

export function registerAdminDestructiveTools(server: McpServer, client: FireflyClient): void {
  const confirm = z
    .literal(CONFIRMATION)
    .describe(`Must be exactly "${CONFIRMATION}". Any other value aborts without deleting anything.`);

  defineTool(
    server,
    'destroy_data',
    {
      title: 'Destroy Data',
      description:
        'IRREVERSIBLY DELETES every record of the chosen type from this Firefly III instance. There is ' +
        'no undo and no backup. Choosing "transactions" erases the entire transaction history; ' +
        '"accounts" erases every account along with everything recorded against it. Requires ' +
        `confirm: "${CONFIRMATION}".`,
      inputSchema: {
        objects: z.enum(DESTROYABLE_OBJECTS).describe('Which type of record to delete permanently'),
        confirm,
      },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ objects, confirm: c }) => destroyData(client, objects as DestroyableObject, c as string),
  );

  defineTool(
    server,
    'purge_data',
    {
      title: 'Purge Deleted Data',
      description:
        'IRREVERSIBLY removes records that were previously deleted, clearing them from the database for ' +
        'good. Until purged, deleted records can still be recovered by an administrator; afterwards ' +
        `they cannot. Requires confirm: "${CONFIRMATION}".`,
      inputSchema: { confirm },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ confirm: c }) => purgeData(client, c as string),
  );
}
