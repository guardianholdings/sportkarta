import 'server-only';

import { sofiaToday, type ClubApiScope } from '@sportkarta/lib/clubs';

import { dayParam, daySpan, UUID_SHAPE, type ApiOutcome } from './api';
import {
  apiBook,
  apiBooking,
  apiCancelBooking,
  apiCheckin,
  apiCheckins,
  apiClasses,
  apiCreateMember,
  apiListMembers,
  apiMember,
  apiPayments,
  apiRecordCheckin,
} from './api-data';
import type { VerifiedClubKey } from './api-keys';
import { MEMBER_FILTERS } from './members';

/**
 * The club's MCP connector (0057): the club API as tools an AI assistant can
 * call — the CLUB connects its OWN assistant (Claude, ChatGPT, anything that
 * speaks MCP) with one of its API keys. POPS sends nothing to an AI provider;
 * the club, as controller of its client records, decides to.
 *
 * Stateless JSON-RPC over Streamable HTTP, JSON responses only (no session,
 * no server-sent stream). Each tool is one api-data.ts function — the same
 * scoped statements as the REST API and the office — and a tool is LISTED
 * only when the key holds its scope. Writes carry MCP's annotations
 * (readOnlyHint false, destructiveHint for a cancellation) so the client
 * asks the person before it acts, and say so in their descriptions too.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST = MCP_PROTOCOL_VERSIONS[0];

type Json = Record<string, unknown>;

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Json;
  isError?: boolean;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  scope: ClubApiScope | null;
  inputSchema: Json;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run(key: VerifiedClubKey, args: Json): Promise<ToolResult>;
}

function ok(data: Json): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function written(outcome: ApiOutcome, data: Json | null): ToolResult {
  if (outcome.errorCode) return failure(`Refused: ${outcome.errorCode}.`);
  return ok({ result: data ?? { id: outcome.resultId ?? null } });
}

/**
 * A write tool answers with the record only to a key that may READ it;
 * otherwise with its id — a write-only key never reads back a client.
 */
function can(key: VerifiedClubKey, scope: ClubApiScope): boolean {
  return key.scopes.includes(scope);
}

function uuidArg(args: Json, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && UUID_SHAPE.test(value) ? value : null;
}

function optionalUuidArg(args: Json, name: string): string | null | 'invalid' {
  if (args[name] === undefined || args[name] === null) return null;
  return uuidArg(args, name) ?? 'invalid';
}

const UUID = { type: 'string', format: 'uuid' } as const;
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/** A from/to pair of Sofia days, at most 31 apart; today by default. */
function range(args: Json): { from: string; to: string } | null {
  const from = args.from === undefined ? sofiaToday() : dayParam(String(args.from));
  const to = args.to === undefined ? from : dayParam(String(args.to));
  if (!from || !to) return null;
  const span = daySpan(from, to);
  return span >= 0 && span < 31 ? { from, to } : null;
}

const TOOLS: readonly Tool[] = [
  {
    name: 'club_info',
    title: 'This club and key',
    description: "The club this connector works for and what its key may do (the key's scopes).",
    scope: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (key) =>
      Promise.resolve(ok({ club_id: key.clubId, slug: key.clubSlug, scopes: key.scopes })),
  },
  {
    name: 'search_members',
    title: 'Find clients',
    description:
      "Search the club's client records by name, e-mail or phone, optionally narrowed by a filter. 50 a page.",
    scope: 'members:read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 100 },
        filter: { type: 'string', enum: [...MEMBER_FILTERS] },
        page: { type: 'integer', minimum: 0, maximum: 1000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (key, args) => {
      const params = new URLSearchParams();
      if (typeof args.query === 'string') params.set('q', args.query);
      if (typeof args.filter === 'string') params.set('filter', args.filter);
      if (typeof args.page === 'number') params.set('page', String(args.page));
      return ok(await apiListMembers(key.actor, params));
    },
  },
  {
    name: 'get_member',
    title: 'One client',
    description: 'A client record with its status, validity, debt and abonnements.',
    scope: 'members:read',
    inputSchema: {
      type: 'object',
      properties: { member_id: UUID },
      required: ['member_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (key, args) => {
      const id = uuidArg(args, 'member_id');
      const member = id ? await apiMember(key.actor, id) : null;
      return member ? ok(member) : failure('No such client at this club.');
    },
  },
  {
    name: 'create_member',
    title: 'Add a client',
    description:
      'Create a client record. Confirm the name and contact details with the person before calling.',
    scope: 'members:write',
    inputSchema: {
      type: 'object',
      properties: {
        display_name: { type: 'string', minLength: 1, maxLength: 120 },
        email: { type: 'string' },
        phone: { type: 'string' },
        is_minor: { type: 'boolean' },
        guardian_member_id: UUID,
        tags: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 20 },
      },
      required: ['display_name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (key, args) => {
      const outcome = await apiCreateMember(key.actor, args);
      const member =
        outcome.resultId && can(key, 'members:read')
          ? await apiMember(key.actor, outcome.resultId)
          : null;
      return written(outcome, member);
    },
  },
  {
    name: 'list_classes',
    title: 'Timetable',
    description:
      'Class dates starting in a window of Sofia days (from today, 7 days, by default; at most 31): times, trainer, places taken and waiting.',
    scope: 'schedule:read',
    inputSchema: {
      type: 'object',
      properties: { from: DAY, days: { type: 'integer', minimum: 1, maximum: 31 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (key, args) => {
      const from = args.from === undefined ? sofiaToday() : dayParam(String(args.from));
      const days = typeof args.days === 'number' ? args.days : 7;
      if (!from || !Number.isInteger(days) || days < 1 || days > 31) {
        return failure('from is YYYY-MM-DD; days is 1–31.');
      }
      return ok({ classes: await apiClasses(key.actor, from, days, null) });
    },
  },
  {
    name: 'book_class',
    title: 'Book a client onto a class',
    description:
      'Book a client onto a class date (a full class puts them on the waiting list). Confirm with the person before calling.',
    scope: 'bookings:write',
    inputSchema: {
      type: 'object',
      properties: { member_id: UUID, class_occurrence_id: UUID },
      required: ['member_id', 'class_occurrence_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (key, args) => {
      const memberId = uuidArg(args, 'member_id');
      const occurrenceId = uuidArg(args, 'class_occurrence_id');
      if (!memberId || !occurrenceId) {
        return failure('member_id and class_occurrence_id are uuids.');
      }
      const outcome = await apiBook(key.actor, occurrenceId, memberId);
      const booking =
        outcome.resultId && can(key, 'attendance:read')
          ? await apiBooking(key.actor, outcome.resultId)
          : null;
      return written(outcome, booking);
    },
  },
  {
    name: 'cancel_booking',
    title: 'Cancel a booking',
    description:
      "Cancel a client's booking, as the desk would (late inside the class's cancellation deadline). Confirm with the person before calling.",
    scope: 'bookings:write',
    inputSchema: {
      type: 'object',
      properties: { booking_id: UUID },
      required: ['booking_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (key, args) => {
      const bookingId = uuidArg(args, 'booking_id');
      if (!bookingId) return failure('booking_id is a uuid.');
      const outcome = await apiCancelBooking(key.actor, bookingId);
      return written(
        outcome,
        can(key, 'attendance:read') ? await apiBooking(key.actor, bookingId) : null,
      );
    },
  },
  {
    name: 'list_checkins',
    title: 'Visits',
    description: 'Visits recorded on a range of Sofia days (today by default; at most 31 days).',
    scope: 'attendance:read',
    inputSchema: {
      type: 'object',
      properties: { from: DAY, to: DAY },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (key, args) => {
      const span = range(args);
      if (!span) return failure('from and to are YYYY-MM-DD, at most 31 days apart.');
      return ok({ ...span, ...(await apiCheckins(key.actor, span.from, span.to)) });
    },
  },
  {
    name: 'record_checkin',
    title: 'Record a visit',
    description:
      'Record that a client is here — for a class date, or an open-gym visit. Recorded even when nothing covers it. Confirm with the person before calling.',
    scope: 'attendance:write',
    inputSchema: {
      type: 'object',
      properties: { member_id: UUID, class_occurrence_id: UUID, location_id: UUID },
      required: ['member_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (key, args) => {
      const memberId = uuidArg(args, 'member_id');
      const occurrenceId = optionalUuidArg(args, 'class_occurrence_id');
      const locationId = optionalUuidArg(args, 'location_id');
      if (!memberId || occurrenceId === 'invalid' || locationId === 'invalid') {
        return failure('member_id, class_occurrence_id and location_id are uuids.');
      }
      const outcome = await apiRecordCheckin(key.actor, { memberId, occurrenceId, locationId });
      const checkin =
        outcome.resultId && can(key, 'attendance:read')
          ? await apiCheckin(key.actor, outcome.resultId)
          : null;
      return written(outcome, checkin);
    },
  },
  {
    name: 'list_payments',
    title: 'Payments',
    description:
      'Payments and refunds received on a range of Sofia days (today by default; at most 31), in euro cents.',
    scope: 'payments:read',
    inputSchema: {
      type: 'object',
      properties: { from: DAY, to: DAY },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async (key, args) => {
      const span = range(args);
      if (!span) return failure('from and to are YYYY-MM-DD, at most 31 days apart.');
      return ok({ ...span, ...(await apiPayments(key.actor, span.from, span.to)) });
    },
  },
];

function toolsFor(key: VerifiedClubKey): readonly Tool[] {
  return TOOLS.filter((tool) => tool.scope === null || key.scopes.includes(tool.scope));
}

/** Every tool and the scope it needs — for the documentation page and its test. */
export const MCP_TOOLS: readonly { name: string; scope: ClubApiScope | null; write: boolean }[] =
  TOOLS.map((tool) => ({
    name: tool.name,
    scope: tool.scope,
    write: !tool.annotations.readOnlyHint,
  }));

type JsonRpcId = string | number;

export type JsonRpcReply =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcReply {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

/** One JSON-RPC message. A notification (no id) answers nothing: null. */
export async function handleMcpMessage(
  key: VerifiedClubKey,
  message: unknown,
): Promise<JsonRpcReply | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid request.');
  }
  const { jsonrpc, id, method, params } = message as Json;
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(isId(id) ? id : null, -32600, 'Invalid request.');
  }
  if (id === undefined) return null;
  if (!isId(id)) return rpcError(null, -32600, 'Invalid request id.');
  const args = typeof params === 'object' && params !== null ? (params as Json) : {};
  switch (method) {
    case 'initialize': {
      const asked = typeof args.protocolVersion === 'string' ? args.protocolVersion : LATEST;
      const version = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pops-club', title: `POPS — ${key.clubSlug}`, version: '1.0.0' },
          instructions:
            "Tools for one sports club's management platform on POPS: its clients, timetable, bookings, visits and payments. Ask the person to confirm before any tool that changes something.",
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: toolsFor(key).map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { title: tool.title, ...tool.annotations, openWorldHint: false },
          })),
        },
      };
    case 'tools/call': {
      const tool = toolsFor(key).find((candidate) => candidate.name === args.name);
      if (!tool) {
        return rpcError(
          id,
          -32602,
          `Unknown tool, or not allowed by this key: ${String(args.name)}.`,
        );
      }
      const raw = args.arguments;
      const toolArgs =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Json) : {};
      return { jsonrpc: '2.0', id, result: await tool.run(key, toolArgs) };
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}.`);
  }
}
