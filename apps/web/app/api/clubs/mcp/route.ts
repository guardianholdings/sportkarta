import { apiError, apiJson, authenticateClubApi, readCappedText } from '@/lib/clubs/api';
import type { VerifiedClubKey } from '@/lib/clubs/api-keys';
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS, type JsonRpcReply } from '@/lib/clubs/mcp';
import { clubApiKeyLimiter } from '@/lib/clubs/rate-limit';
import { siteUrl } from '@/lib/seo';

/**
 * POST /api/clubs/mcp — the club's MCP connector (0057; apps/web/lib/clubs/mcp.ts).
 * Streamable HTTP, stateless, JSON responses only: a request gets its
 * JSON-RPC reply, notifications get 202. GET is not exported, so Next answers
 * 405 — which is what the transport asks of a server with no event stream.
 *
 * Authenticated with a club API key (Bearer), like the REST API, and gated by
 * the 'mcp' feature. A request that carries an Origin other than our own is
 * refused (the transport's DNS-rebinding rule): an assistant calls from a
 * server or a desktop app, never from a web page on another site.
 */

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

function rpcId(message: unknown): string | number | null {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** One message's reply; a tool that throws is that message's error, not a 500. */
async function answer(key: VerifiedClubKey, message: unknown): Promise<JsonRpcReply | null> {
  try {
    return await handleMcpMessage(key, message);
  } catch {
    return {
      jsonrpc: '2.0',
      id: rpcId(message),
      error: { code: -32603, message: 'Internal error.' },
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(siteUrl()).origin) {
    return apiError(403, 'origin_not_allowed', 'This endpoint is not for browser pages.');
  }
  const auth = await authenticateClubApi(request, { scope: null, feature: 'mcp' });
  if (!auth.ok) return auth.response;
  const { key, headers } = auth.caller;
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return apiError(
      400,
      'unsupported_protocol_version',
      `Supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}.`,
      headers,
    );
  }
  const raw = await readCappedText(request, MAX_BODY_BYTES);
  if (raw === null) return apiError(413, 'too_large', 'The body is too large.', headers);
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return apiJson(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } },
      400,
      headers,
    );
  }
  // A batch (protocol 2025-03-26) is answered as a batch; later versions send
  // one. Its messages run IN ORDER, each beyond the first spends the key's
  // budget like a request of its own, and one that throws answers with its
  // own error — the writes before it have happened and are reported.
  if (Array.isArray(message)) {
    const replies: JsonRpcReply[] = [];
    for (const [index, one] of message.slice(0, 20).entries()) {
      const id = rpcId(one);
      if (index > 0 && !clubApiKeyLimiter.check(key.keyId).allowed) {
        replies.push({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Rate limited.' } });
        continue;
      }
      const reply = await answer(key, one);
      if (reply) replies.push(reply);
    }
    return replies.length === 0
      ? new Response(null, { status: 202, headers })
      : apiJson(replies, 200, headers);
  }
  const reply = await answer(key, message);
  return reply === null
    ? new Response(null, { status: 202, headers })
    : apiJson(reply, 200, headers);
}
