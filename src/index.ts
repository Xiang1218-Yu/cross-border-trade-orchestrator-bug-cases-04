import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  addShipmentEvent, allocateOrder, cancelOrder, claimOutbox, closeOrder, confirmOrder, createApproval, createCustomsDeclaration, createOrder, decideApproval, deliverOrder, dispatchOrder, failOutbox, generateInvoice, getOrder, getOutboxEvent, invoiceOverdue, listAudit, listOrders, listOrdersPage, listOutbox, operationSummary, publishOutbox, recordPayment, retryOutbox, state, timeline, updateCustoms,
  type OutboxStatus
} from './domain.js';

const port = Number(process.env.PORT ?? 4120);
const json = (res: ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); };
const readBody = async (req: IncomingMessage) => { let raw = ''; for await (const chunk of req) raw += chunk; if (!raw.trim()) return {}; try { return JSON.parse(raw); } catch { throw new Error('请求体必须是合法 JSON'); } };
const tenantId = (req: IncomingMessage) => String(req.headers['x-tenant-id'] ?? 'tenant-acme');
const actor = (req: IncomingMessage) => String(req.headers['x-actor'] ?? 'api-user');
const success = (res: ServerResponse, body: unknown, status = 200) => json(res, status, { data: body });
const failure = (res: ServerResponse, error: unknown, status = 400) => json(res, status, { error: error instanceof Error ? error.message : '请求失败' });

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET'; const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); const path = url.pathname; const tenant = tenantId(req); const user = actor(req);
  if (method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (path === '/api/health') return success(res, { ok: true, service: 'cross-border-trade-orchestrator', now: new Date().toISOString() });
  if (!path.startsWith('/api/')) return failure(res, new Error('Not Found'), 404);
  try {
    if (method === 'GET' && path === '/api/operations/summary') return success(res, operationSummary(tenant));
    if (method === 'GET' && path === '/api/orders') return success(res, listOrders(tenant, { status: url.searchParams.get('status') ?? undefined, customerId: url.searchParams.get('customerId') ?? undefined, q: url.searchParams.get('q') ?? undefined }));
    if (method === 'GET' && path === '/api/orders/page') return success(res, listOrdersPage(tenant, { cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 20) }));
    const orderId = path.match(/^\/api\/orders\/([^/]+)$/)?.[1];
    if (method === 'GET' && orderId) return success(res, getOrder(tenant, orderId));
    if (method === 'GET' && orderId && path.endsWith('/timeline')) return success(res, timeline(tenant, orderId));
    if (method === 'POST' && path === '/api/orders') return success(res, createOrder(tenant, await readBody(req), user), 201);
    if (method === 'POST' && orderId && path.endsWith('/confirm')) return success(res, confirmOrder(tenant, orderId, user));
    if (method === 'POST' && orderId && path.endsWith('/allocate')) return success(res, allocateOrder(tenant, orderId, user));
    if (method === 'POST' && orderId && path.endsWith('/dispatch')) return success(res, dispatchOrder(tenant, orderId, user));
    if (method === 'POST' && orderId && path.endsWith('/deliver')) return success(res, deliverOrder(tenant, orderId, user));
    if (method === 'POST' && orderId && path.endsWith('/close')) return success(res, closeOrder(tenant, orderId, user));
    if (method === 'POST' && orderId && path.endsWith('/cancel')) return success(res, cancelOrder(tenant, orderId, user));

    if (method === 'POST' && path === '/api/customs/declarations') return success(res, createCustomsDeclaration(tenant, await readBody(req), user), 201);
    const customsId = path.match(/^\/api\/customs\/declarations\/([^/]+)$/)?.[1];
    if (method === 'PATCH' && customsId) return success(res, updateCustoms(tenant, customsId, await readBody(req), user));
    const shipmentId = path.match(/^\/api\/shipments\/([^/]+)\/events$/)?.[1];
    if (method === 'POST' && shipmentId) return success(res, addShipmentEvent(tenant, shipmentId, await readBody(req), user), 201);

    if (method === 'POST' && path === '/api/invoices') { const body = await readBody(req); return success(res, generateInvoice(tenant, String(body.orderId), user), 201); }
    if (method === 'POST' && path === '/api/payments') return success(res, recordPayment(tenant, await readBody(req), user), 201);
    const invoiceId = path.match(/^\/api\/invoices\/([^/]+)\/overdue$/)?.[1];
    if (method === 'GET' && invoiceId) return success(res, invoiceOverdue(tenant, invoiceId, url.searchParams.get('asOf') ? new Date(String(url.searchParams.get('asOf'))) : new Date()));
    if (method === 'POST' && path === '/api/approvals') return success(res, createApproval(tenant, await readBody(req), user), 201);
    const approvalId = path.match(/^\/api\/approvals\/([^/]+)\/decision$/)?.[1];
    if (method === 'POST' && approvalId) return success(res, decideApproval(tenant, approvalId, await readBody(req), user));
    if (method === 'GET' && path === '/api/audit/events') return success(res, listAudit(tenant, Number(url.searchParams.get('limit') ?? 100)));
    if (method === 'GET' && path === '/api/outbox') return success(res, listOutbox(tenant, { status: (url.searchParams.get('status') as OutboxStatus | null) ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined }));
    const outboxEventId = path.match(/^\/api\/outbox\/([^/]+)$/)?.[1];
    if (method === 'GET' && outboxEventId) return success(res, getOutboxEvent(tenant, outboxEventId));
    const claimId = path.match(/^\/api\/outbox\/([^/]+)\/claim$/)?.[1];
    if (method === 'POST' && claimId) return success(res, claimOutbox(tenant, claimId, user));
    const retryId = path.match(/^\/api\/outbox\/([^/]+)\/retry$/)?.[1];
    if (method === 'POST' && retryId) return success(res, retryOutbox(tenant, retryId, user));
    const failId = path.match(/^\/api\/outbox\/([^/]+)\/fail$/)?.[1];
    if (method === 'POST' && failId) { const body = await readBody(req); return success(res, failOutbox(tenant, failId, user, body.reason ? String(body.reason) : undefined)); }
    const eventId = path.match(/^\/api\/outbox\/([^/]+)\/publish$/)?.[1];
    if (method === 'POST' && eventId) return success(res, publishOutbox(tenant, eventId, user));
    if (method === 'GET' && path === '/api/meta') return success(res, { tenant: state.tenants.find(item => item.id === tenant), capabilities: ['orders', 'inventory-reservation', 'shipment-tracking', 'customs-compliance', 'billing', 'approvals', 'audit', 'outbox'] });
    return failure(res, new Error('路由不存在'), 404);
  } catch (error) { return failure(res, error); }
});

server.listen(port, () => console.log(`cross-border trade orchestrator listening on http://localhost:${port}`));
