import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, claimOutbox, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, failOutbox, generateInvoice, getOutboxEvent, listOutbox, operationSummary, publishOutbox, recordPayment, retryOutbox, state, updateCustoms } from './domain.js';

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});

test('outbox list, detail, claim, retry and publish are isolated per tenant', () => {
  state.tenants.push({ id: 'tenant-globex', name: 'Globex Trading', creditLimit: 100000, creditUsed: 0, currency: 'USD' });
  state.customers.push({ id: 'CUS-G01', tenantId: 'tenant-globex', name: 'Globex Retail', creditLimit: 50000, creditUsed: 0, blocked: false });
  createOrder('tenant-globex', { customerId: 'CUS-G01', reference: `FOREIGN-${Date.now()}`, origin: '柏林', destination: '纽约', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 10, weightKg: 1, hsCode: '9025.19' }] });
  const foreign = state.outbox.find(item => item.tenantId === 'tenant-globex')!;
  assert.ok(foreign);

  const acmePage = listOutbox('tenant-acme', {});
  assert.ok(acmePage.items.length > 0);
  assert.ok(acmePage.items.every(item => item.tenantId === 'tenant-acme'));
  assert.equal(acmePage.total, state.outbox.filter(item => item.tenantId === 'tenant-acme').length);
  const globexPending = listOutbox('tenant-globex', { status: 'pending' });
  assert.ok(globexPending.items.every(item => item.tenantId === 'tenant-globex' && item.status === 'pending'));
  const firstPage = listOutbox('tenant-acme', { limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  assert.ok(listOutbox('tenant-acme', { limit: 1, cursor: firstPage.nextCursor }).items.every(item => item.id !== firstPage.items[0].id));

  const auditBefore = state.audit.length;
  for (const eventId of [foreign.id, 'EVT-DOES-NOT-EXIST']) {
    assert.throws(() => getOutboxEvent('tenant-acme', eventId), /^Error: 事件不存在$/);
    assert.throws(() => claimOutbox('tenant-acme', eventId, 'attacker'), /^Error: 事件不存在$/);
    assert.throws(() => retryOutbox('tenant-acme', eventId, 'attacker'), /^Error: 事件不存在$/);
    assert.throws(() => failOutbox('tenant-acme', eventId, 'attacker'), /^Error: 事件不存在$/);
    assert.throws(() => publishOutbox('tenant-acme', eventId, 'attacker'), /^Error: 事件不存在$/);
  }
  const untouched = state.outbox.find(item => item.id === foreign.id)!;
  assert.equal(untouched.status, 'pending');
  assert.equal(untouched.attempts, 0);
  assert.equal(state.audit.length, auditBefore);
  assert.equal(getOutboxEvent('tenant-globex', foreign.id).topic, untouched.topic);
});

test('outbox claim, fail, retry and publish keep status and audit consistent', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `OUTBOX-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  const event = state.outbox.find(item => item.tenantId === 'tenant-acme' && item.aggregateId === order.id && item.topic === 'order.created')!;
  assert.equal(event.status, 'pending');

  const claimed = claimOutbox('tenant-acme', event.id, 'ops-1');
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.claimedBy, 'ops-1');
  assert.throws(() => claimOutbox('tenant-acme', event.id, 'ops-2'), /事件已被领取/);

  const failed = failOutbox('tenant-acme', event.id, 'ops-1', '下游通道不可用');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, '下游通道不可用');
  assert.throws(() => publishOutbox('tenant-acme', event.id, 'ops-1'), /请先重试/);
  assert.throws(() => claimOutbox('tenant-acme', event.id, 'ops-1'), /请先重试/);

  const retried = retryOutbox('tenant-acme', event.id, 'ops-1');
  assert.equal(retried.status, 'pending');
  assert.equal(retried.claimedBy, undefined);
  assert.throws(() => retryOutbox('tenant-acme', event.id, 'ops-1'), /只有失败的事件才能重试/);

  const published = publishOutbox('tenant-acme', event.id, 'ops-1');
  assert.equal(published.status, 'published');
  assert.ok(published.publishedAt);
  const attemptsAfterPublish = published.attempts;
  const duplicate = publishOutbox('tenant-acme', event.id, 'ops-1');
  assert.equal(duplicate.status, 'published');
  assert.equal(duplicate.attempts, attemptsAfterPublish);
  assert.throws(() => claimOutbox('tenant-acme', event.id, 'ops-1'), /已发布/);
  assert.throws(() => failOutbox('tenant-acme', event.id, 'ops-1'), /已发布/);

  const actions = state.audit.filter(item => item.entityType === 'outbox' && item.entityId === event.id).map(item => item.action);
  assert.equal(actions.filter(action => action === 'outbox.claimed').length, 1);
  assert.equal(actions.filter(action => action === 'outbox.failed').length, 1);
  assert.equal(actions.filter(action => action === 'outbox.retried').length, 1);
  assert.equal(actions.filter(action => action === 'outbox.published').length, 1);
  assert.equal(state.outbox.find(item => item.id === event.id)!.status, 'published');
});
