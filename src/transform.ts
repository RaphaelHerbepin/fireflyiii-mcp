export interface JsonApiItem {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  links?: unknown;
}

export interface JsonApiListResponse {
  data: JsonApiItem[];
  meta?: {
    pagination?: {
      current_page: number;
      total_pages: number;
      total: number;
    };
  };
}

export interface JsonApiSingleResponse {
  data: JsonApiItem;
}

export type RawSummaryResponse = Record<string, Record<string, unknown>>;

export interface CleanSummaryItem {
  key: string;
  value: {
    key: string;
    title: string;
    monetary_value: string;
    currency_id: string;
    currency_code: string;
    value_parsed: string;
  };
}

export interface UnwrappedList {
  data: Array<{ id: string } & Record<string, unknown>>;
  pagination?: { page: number; totalPages: number; total: number };
}

export type UnwrappedSingle = { id: string } & Record<string, unknown>;

export function unwrapList(response: JsonApiListResponse): UnwrappedList {
  return {
    data: response.data.map((item) => ({ ...item.attributes, id: item.id })),
    pagination: response.meta?.pagination
      ? {
          page: response.meta.pagination.current_page,
          totalPages: response.meta.pagination.total_pages,
          total: response.meta.pagination.total,
        }
      : undefined,
  };
}

export function unwrapSingle(response: JsonApiSingleResponse): UnwrappedSingle {
  return { ...response.data.attributes, id: response.data.id };
}

export function cleanSummary(response: RawSummaryResponse): CleanSummaryItem[] {
  return Object.entries(response).map(([key, value]) => ({
    key,
    value: {
      key: value.key as string,
      title: value.title as string,
      monetary_value: value.monetary_value as string,
      currency_id: value.currency_id as string,
      currency_code: value.currency_code as string,
      value_parsed: value.value_parsed as string,
    },
  }));
}

/** Preset names accepted by the `fields` parameter of read tools. */
export type FieldPreset = 'compact' | 'standard' | 'full';

/** Either a preset name or an explicit list of field names. */
export type FieldSelector = FieldPreset | string[];

/**
 * Projects a flat object onto a subset of its keys.
 *
 * `id` is always kept, even when the caller does not ask for it: without it no follow-up is possible —
 * no update, no delete, no detail fetch — so dropping it would make the response unusable for
 * anything but reading.
 *
 * A requested key the object does not have is skipped rather than emitted as `undefined`, because an
 * `undefined` value still serialises a key and costs tokens for nothing. The test is `Object.hasOwn`,
 * not `!== undefined`: a field whose value is genuinely `null` must survive, since `category_name:
 * null` is exactly the signal an uncategorised-transaction search looks for.
 *
 * Keys come out in the order they were requested, with `id` first. Order is stable through
 * `JSON.stringify`, so it decides how a model reads each row.
 */
export function pickFields<T extends Record<string, unknown>>(obj: T, fields: string[] | '*'): Partial<T> {
  if (fields === '*') return obj;

  const picked: Record<string, unknown> = {};
  if (Object.hasOwn(obj, 'id')) picked.id = obj.id;
  for (const field of fields) {
    if (field !== 'id' && Object.hasOwn(obj, field)) picked[field] = obj[field];
  }
  return picked as Partial<T>;
}

/** {@link pickFields} over a list. */
export function pickFieldsList(
  items: Array<Record<string, unknown>>,
  fields: string[] | '*',
): Array<Record<string, unknown>> {
  if (fields === '*') return items;
  return items.map((item) => pickFields(item, fields));
}
