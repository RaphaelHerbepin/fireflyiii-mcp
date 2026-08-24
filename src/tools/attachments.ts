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
import { type ContentResult, defineContentTool, defineTool } from './_helpers.js';

// ---- Attachment fetch + CRUD ----

export async function fetchAttachments(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  const response = await client.get<JsonApiListResponse>('/attachments', { page: params.page, limit: params.limit });
  return unwrapList(response);
}

export async function fetchAttachment(client: FireflyClient, id: string): Promise<UnwrappedSingle> {
  const response = await client.get<JsonApiSingleResponse>(`/attachments/${id}`);
  return unwrapSingle(response);
}

export async function createAttachment(
  client: FireflyClient,
  params: { filename: string; attachable_type: string; attachable_id: string; title?: string; notes?: string },
): Promise<UnwrappedSingle> {
  const response = await client.post<JsonApiSingleResponse>('/attachments', params);
  return unwrapSingle(response);
}

export async function updateAttachment(
  client: FireflyClient,
  id: string,
  params: { filename?: string; title?: string; notes?: string },
): Promise<UnwrappedSingle> {
  const response = await client.put<JsonApiSingleResponse>(`/attachments/${id}`, params);
  return unwrapSingle(response);
}

export async function deleteAttachment(client: FireflyClient, id: string): Promise<{ deleted: true; id: string }> {
  await client.delete(`/attachments/${id}`);
  return { deleted: true, id };
}

export async function uploadAttachment(
  client: FireflyClient,
  id: string,
  content: Uint8Array,
): Promise<{ uploaded: true; id: string }> {
  await client.postBinary(`/attachments/${id}/upload`, content);
  return { uploaded: true, id };
}

export interface DownloadedAttachment {
  content_base64: string;
  content_type: string;
  filename: string;
}

export async function downloadAttachment(client: FireflyClient, id: string): Promise<DownloadedAttachment> {
  const { data, contentType, filename } = await client.getBinary(`/attachments/${id}/download`);
  return {
    content_base64: data.toString('base64'),
    content_type: contentType,
    filename,
  };
}

/**
 * Map a downloaded attachment to an MCP result. Image attachments are returned
 * as a native `image` content block so clients can render them; everything else
 * is returned as a text block carrying the filename, MIME type, and Base64 data.
 */
export function downloadAttachmentContent(file: DownloadedAttachment): ContentResult {
  const mimeType = file.content_type.split(';')[0].trim();
  if (mimeType.startsWith('image/')) {
    return { content: [{ type: 'image', data: file.content_base64, mimeType }] };
  }
  return {
    content: [
      {
        type: 'text',
        text: `filename: ${file.filename}\ncontent_type: ${file.content_type}\ncontent_base64: ${file.content_base64}`,
      },
    ],
  };
}

/**
 * Entity types that can carry attachments, mapped to their path segment.
 *
 * Seven endpoints of identical shape become one tool. Exported so scripts/check-api-coverage.ts can
 * expand them — fetchAttachmentsFor takes the type as a parameter, so static analysis sees one route
 * where there are seven.
 */
export const ATTACHABLE_ENTITIES = {
  account: 'accounts',
  bill: 'bills',
  budget: 'budgets',
  category: 'categories',
  'piggy-bank': 'piggy-banks',
  // Tags are addressed by name rather than id, so the identifier needs encoding.
  tag: 'tags',
  transaction: 'transactions',
} as const;

export type AttachableEntity = keyof typeof ATTACHABLE_ENTITIES;

export const ATTACHABLE_ENTITY_NAMES = Object.keys(ATTACHABLE_ENTITIES) as [AttachableEntity, ...AttachableEntity[]];

/** Attachments belonging to one record, whatever kind of record it is. */
export async function fetchAttachmentsFor(
  client: FireflyClient,
  entityType: AttachableEntity,
  id: string,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  const segment = ATTACHABLE_ENTITIES[entityType];
  return unwrapList(
    await client.get<JsonApiListResponse>(`/${segment}/${encodeURIComponent(id)}/attachments`, {
      page: params.page,
      limit: params.limit,
    }),
  );
}

export function registerAttachmentTools(server: McpServer, client: FireflyClient): void {
  defineTool(
    server,
    'get_attachments',
    {
      title: 'Get Attachments',
      description: 'Get all file attachments from Firefly III.',
      inputSchema: {
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ page, limit }) =>
      fetchAttachments(client, { page: page as number | undefined, limit: limit as number | undefined }),
  );

  defineTool(
    server,
    'get_attachment',
    {
      title: 'Get Attachment',
      description: 'Get a single file attachment by its numeric ID. Use get_attachments to find valid IDs.',
      inputSchema: {
        id: z.string().describe('Attachment ID'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ id }) => fetchAttachment(client, id as string),
  );

  defineTool(
    server,
    'get_attachments_for',
    {
      title: 'Get Attachments for a Record',
      description:
        'List the files attached to one account, bill, budget, category, piggy bank, tag or ' +
        'transaction — receipts, invoices, statements. Use download_attachment to fetch the contents.',
      inputSchema: {
        entity_type: z.enum(ATTACHABLE_ENTITY_NAMES).describe('What kind of record to look under'),
        id: z.string().describe('The record ID. For tags, the tag name.'),
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ entity_type, id, page, limit }) =>
      fetchAttachmentsFor(client, entity_type as AttachableEntity, id as string, {
        page: page as number | undefined,
        limit: limit as number | undefined,
      }),
  );

  defineTool(
    server,
    'create_attachment',
    {
      title: 'Create Attachment',
      description:
        'Create attachment metadata in Firefly III. This creates the metadata record only — use upload_attachment to send the actual file content. The returned ID is needed for the upload step.',
      inputSchema: {
        filename: z.string().describe('Filename including extension, e.g. receipt.pdf'),
        attachable_type: z
          .enum(['Account', 'Budget', 'Bill', 'TransactionJournal', 'PiggyBank', 'Tag'])
          .describe('Type of object this attachment belongs to'),
        attachable_id: z.string().describe('ID of the object this attachment belongs to'),
        title: z.string().optional().describe('Human-readable title'),
        notes: z.string().optional().describe('Notes'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ filename, attachable_type, attachable_id, title, notes }) =>
      createAttachment(client, {
        filename: filename as string,
        attachable_type: attachable_type as string,
        attachable_id: attachable_id as string,
        title: title as string | undefined,
        notes: notes as string | undefined,
      }),
  );

  defineTool(
    server,
    'update_attachment',
    {
      title: 'Update Attachment',
      description:
        'Update attachment metadata. Only fields provided will be changed. Use get_attachment to confirm the ID before updating.',
      inputSchema: {
        id: z.string().describe('Attachment ID — use get_attachments to find valid IDs'),
        filename: z.string().optional().describe('Filename including extension'),
        title: z.string().optional().describe('Human-readable title'),
        notes: z.string().optional().describe('Notes'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, filename, title, notes }) =>
      updateAttachment(client, id as string, {
        filename: filename as string | undefined,
        title: title as string | undefined,
        notes: notes as string | undefined,
      }),
  );

  defineTool(
    server,
    'delete_attachment',
    {
      title: 'Delete Attachment',
      description:
        'Permanently delete an attachment and its file data from Firefly III. **This action cannot be undone.** Use get_attachment to confirm before deleting.',
      inputSchema: {
        id: z.string().describe('Attachment ID — use get_attachments to find valid IDs'),
      },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id }) => deleteAttachment(client, id as string),
  );

  defineTool(
    server,
    'upload_attachment',
    {
      title: 'Upload Attachment File',
      description:
        'Upload the binary content for an existing attachment record. Call create_attachment first to get the attachment ID, then call this tool with the base64-encoded file content. The two-step workflow: (1) create_attachment → get ID, (2) upload_attachment with that ID and content_base64.',
      inputSchema: {
        id: z.string().describe('Attachment ID from create_attachment'),
        content_base64: z.string().describe('File content encoded as base64'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ id, content_base64 }) => uploadAttachment(client, id as string, Buffer.from(content_base64 as string, 'base64')),
  );

  defineContentTool(
    server,
    'download_attachment',
    {
      title: 'Download Attachment',
      description:
        'Download a file attachment (such as an invoice, PDF, or image receipt) by its ID. Image attachments are returned as a rendered image; other files are returned as their filename, MIME content type, and Base64-encoded content. Use get_attachments to find valid IDs.',
      inputSchema: {
        id: z.string().describe('Attachment ID'),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ id }) => downloadAttachmentContent(await downloadAttachment(client, id as string)),
  );
}
