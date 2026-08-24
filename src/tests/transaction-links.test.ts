import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  createLinkType,
  createTransactionLink,
  deleteLinkType,
  deleteTransactionLink,
  fetchAllTransactionLinks,
  fetchLinkType,
  fetchLinkTypes,
  fetchLinkTypeTransactions,
  fetchTransactionLink,
  fetchTransactionLinks,
  registerTransactionLinkTools,
  updateLinkType,
  updateTransactionLink,
} from '../tools/transaction-links.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

const listFixture = {
  data: [{ id: '1', type: 'link_types', attributes: { name: 'Related', editable: true }, links: {} }],
  meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
};
const linkSingle = {
  data: {
    id: '5',
    type: 'transaction_links',
    attributes: { link_type_id: '1', inward_id: '10', outward_id: '11', notes: '' },
    links: {},
  },
};

describe('fetchLinkTypes', () => {
  it('calls /link-types with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchLinkTypes(mockClient, { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/link-types', { page: 1, limit: 50 });
  });
});

describe('fetchTransactionLinks', () => {
  it('calls /transaction-journals/:id/links', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchTransactionLinks(mockClient, '10', { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/transaction-journals/10/links', { page: 1, limit: 50 });
  });
});

describe('fetchTransactionLink', () => {
  it('calls /transaction-links/:id', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(linkSingle);
    await fetchTransactionLink(mockClient, '5');
    expect(mockClient.get).toHaveBeenCalledWith('/transaction-links/5');
  });
});

describe('createTransactionLink', () => {
  it('posts to /transaction-links', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(linkSingle);
    await createTransactionLink(mockClient, { link_type_id: '1', inward_id: '10', outward_id: '11' });
    expect(mockClient.post).toHaveBeenCalledWith('/transaction-links', {
      link_type_id: '1',
      inward_id: '10',
      outward_id: '11',
    });
  });
});

describe('updateTransactionLink', () => {
  it('puts to /transaction-links/:id', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(linkSingle);
    await updateTransactionLink(mockClient, '5', { notes: 'related purchase' });
    expect(mockClient.put).toHaveBeenCalledWith('/transaction-links/5', { notes: 'related purchase' });
  });
});

describe('deleteTransactionLink', () => {
  it('calls delete and returns confirmation', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    const result = await deleteTransactionLink(mockClient, '5');
    expect(mockClient.delete).toHaveBeenCalledWith('/transaction-links/5');
    expect(result).toEqual({ deleted: true, id: '5' });
  });
});

describe('handler smoke — transaction-links', () => {
  it('get_link_types handler returns text content on success', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockResolvedValueOnce(listFixture) } as unknown as FireflyClient;
    registerTransactionLinkTools(server, client);
    const result = await handlers.get('get_link_types')!({});
    expect(result).toMatchObject({ content: [{ type: 'text', text: expect.any(String) }] });
  });

  it('get_link_types handler returns isError on failure', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockRejectedValueOnce(new Error('Network error')) } as unknown as FireflyClient;
    registerTransactionLinkTools(server, client);
    const result = await handlers.get('get_link_types')!({});
    expect(result).toMatchObject({ isError: true });
  });
});

describe('link types', () => {
  const linkTypeSingle = {
    data: {
      id: '4',
      type: 'link_types',
      attributes: { name: 'Refund', inward: 'is refunded by', outward: 'refunds', editable: true },
      links: {},
    },
  };
  const linkTypeList = {
    data: [linkTypeSingle.data],
    meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
  };

  it('reads one link type', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(linkTypeSingle);
    expect(await fetchLinkType(mockClient, '4')).toMatchObject({ id: '4', name: 'Refund' });
    expect(mockClient.get).toHaveBeenCalledWith('/link-types/4');
  });

  it('lists the transactions connected by a link type', async () => {
    // The question link types exist to answer: "show me everything marked as a refund".
    mockClient.get = vi.fn().mockResolvedValueOnce(linkTypeList);
    await fetchLinkTypeTransactions(mockClient, '4', { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/link-types/4/transactions', { page: 1, limit: 50 });
  });

  it('creates a link type with both directions of phrasing', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(linkTypeSingle);
    await createLinkType(mockClient, { name: 'Refund', inward: 'is refunded by', outward: 'refunds' });
    expect(mockClient.post).toHaveBeenCalledWith('/link-types', {
      name: 'Refund',
      inward: 'is refunded by',
      outward: 'refunds',
    });
  });

  it('updates and deletes a link type', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(linkTypeSingle);
    await updateLinkType(mockClient, '4', { name: 'Reimbursement' });
    expect(mockClient.put).toHaveBeenCalledWith('/link-types/4', { name: 'Reimbursement' });

    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    expect(await deleteLinkType(mockClient, '4')).toEqual({ deleted: true, id: '4' });
  });

  it('lists every link on the instance, not just one journal’s', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(linkTypeList);
    await fetchAllTransactionLinks(mockClient, { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/transaction-links', { page: 1, limit: 50 });
  });

  it('warns that deleting a link type removes the links using it', () => {
    const { server, toolConfigs } = createMockServer();
    registerTransactionLinkTools(server, mockClient);
    // The transactions survive; the relationships between them do not, and that is not obvious.
    expect(toolConfigs.get('delete_link_type').description).toMatch(/every link using it is\s+removed/i);
  });
});
