import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimOutboxEvent, getOutboxEvent, listAudit, listOutbox, outboxDeliveryCount, publishOutbox, retryOutboxEvent, state, timeline
} from './domain.js';

const A = 'tenant-acme';
const B = 'tenant-globex';

function pendingEvent(tenantId: string) {
  const found = state.outbox.find(item => item.tenantId === tenantId && item.status === 'pending');
  assert.ok(found, 'fixture should have a pending event for the tenant');
  return found!.id;
}

test('outbox list is strictly tenant scoped with pagination', () => {
  const idsA = listOutbox(A).items.map(item => item.id);
  const idsB = listOutbox(B).items.map(item => item.id);
  assert.ok(idsA.length > 0 && idsB.length > 0);
  assert.deepEqual(idsA.filter(id => idsB.includes(id)), []);
  assert.ok(listOutbox(A).items.every(item => item.tenantId === A));
  assert.ok(listOutbox(B).items.every(item => item.tenantId === B));

  const page1 = listOutbox(A, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = listOutbox(A, { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map(item => item.id).some(id => page1.items.some(p => p.id === id)), false);

  const pendingB = listOutbox(B, 'pending');
  assert.ok(pendingB.items.every(item => item.status === 'pending' && item.tenantId === B));
});

test('cross-tenant and unknown ids return identical business errors for detail/claim/retry/publish', () => {
  const idB = pendingEvent(B);
  const unknown = 'EVT-DOESNOTEXIST';
  for (const target of [idB, unknown]) {
    assert.throws(() => getOutboxEvent(A, target), /^Error: 事件不存在$/);
    assert.throws(() => claimOutboxEvent(A, target, 'op-a'), /^Error: 事件不存在$/);
    assert.throws(() => retryOutboxEvent(A, target, 'op-a'), /^Error: 事件不存在$/);
    assert.throws(() => publishOutbox(A, target, 'op-a'), /^Error: 事件不存在$/);
  }
  // cross-tenant attempts must never be recorded in audit
  assert.ok(!listAudit(A).some(e => e.entityId === idB));
  assert.ok(!listAudit(B).some(e => e.entityId === idB && e.actor === 'op-a'));
});

test('claim moves pending to processing once; concurrent and repeat claims get a conflict', () => {
  const id = pendingEvent(A);
  const first = claimOutboxEvent(A, id, 'op-a');
  assert.equal(first.outcome, 'claimed');
  assert.equal(first.event.status, 'processing');
  assert.equal(first.event.claimedBy, 'op-a');

  // second concurrent claim, same actor or another actor
  assert.equal(claimOutboxEvent(A, id, 'op-a').outcome, 'conflict');
  assert.equal(claimOutboxEvent(A, id, 'op-b').outcome, 'conflict');
  assert.equal(getOutboxEvent(A, id).status, 'processing');
  assert.equal(getOutboxEvent(A, id).claimedBy, 'op-a');

  // another tenant cannot claim the processing event either and cannot probe its state
  assert.throws(() => claimOutboxEvent(B, id, 'op-b'), /^Error: 事件不存在$/);
});

test('publish requires ownership and processing state', () => {
  const id = pendingEvent(A);
  // publishing a pending (unclaimed) event is rejected without delivery
  assert.equal(publishOutbox(A, id, 'op-a').outcome, 'conflict');
  assert.equal(outboxDeliveryCount(A, id), 0);

  claimOutboxEvent(A, id, 'op-a');
  // a different operator cannot publish someone else's claim
  assert.equal(publishOutbox(A, id, 'op-b').outcome, 'conflict');
  assert.equal(getOutboxEvent(A, id).status, 'processing');
  assert.equal(outboxDeliveryCount(A, id), 0);

  // cross-tenant publish cannot target the claimed event
  assert.throws(() => publishOutbox(B, id, 'op-b'), /^Error: 事件不存在$/);
});

test('failed publish marks failed; retry returns it to pending and release; publish then succeeds once', () => {
  const id = pendingEvent(A);
  claimOutboxEvent(A, id, 'op-a');

  const failed = publishOutbox(A, id, 'op-a', { fail: 'broker timeout' });
  assert.equal(failed.outcome, 'publish_failed');
  assert.equal(failed.event.status, 'failed');
  assert.equal(failed.event.attempts, 1);
  assert.equal(failed.event.lastError, 'broker timeout');
  assert.equal(outboxDeliveryCount(A, id), 0);

  // retry is only valid from failed
  assert.equal(publishOutbox(A, id, 'op-a').outcome, 'conflict');
  const retried = retryOutboxEvent(A, id, 'op-a');
  assert.equal(retried.outcome, 'retried');
  assert.equal(retried.event.status, 'pending');
  assert.equal(retried.event.claimedBy, undefined);
  assert.equal(retryOutboxEvent(A, id, 'op-a').outcome, 'conflict');

  claimOutboxEvent(A, id, 'op-a');
  const published = publishOutbox(A, id, 'op-a');
  assert.equal(published.outcome, 'published');
  assert.equal(published.event.status, 'published');
  assert.equal(published.delivery?.eventId, id);
  assert.equal(outboxDeliveryCount(A, id), 1);

  // duplicate publish is idempotent and never delivers twice
  const again = publishOutbox(A, id, 'op-a');
  assert.equal(again.outcome, 'already_published');
  assert.equal(outboxDeliveryCount(A, id), 1);
});

test('published events cannot be retried or re-claimed', () => {
  const id = pendingEvent(B);
  claimOutboxEvent(B, id, 'op-b');
  publishOutbox(B, id, 'op-b');
  assert.equal(retryOutboxEvent(B, id, 'op-b').outcome, 'conflict');
  assert.equal(claimOutboxEvent(B, id, 'op-b').outcome, 'conflict');
  assert.equal(getOutboxEvent(B, id).status, 'published');
});

test('audit and timeline stay consistent with outbox lifecycle and tenant boundary', () => {
  const id = pendingEvent(B);
  claimOutboxEvent(B, id, 'op-b');
  publishOutbox(B, id, 'op-b', { fail: 'downstream unavailable' });
  retryOutboxEvent(B, id, 'op-b');
  claimOutboxEvent(B, id, 'op-b');
  publishOutbox(B, id, 'op-b');

  const actions = listAudit(B).filter(e => e.entityId === id).map(e => e.action);
  assert.deepEqual(actions, ['outbox.published', 'outbox.claimed', 'outbox.retried', 'outbox.publish_failed', 'outbox.claimed']);
  // only one published audit and exactly one delivery
  assert.equal(actions.filter(a => a === 'outbox.published').length, 1);
  assert.equal(outboxDeliveryCount(B, id), 1);
  // tenant A's audit never mentions B's event
  assert.ok(!listAudit(A).some(e => e.entityId === id));

  // timeline of the owning tenant's order shows the outbox lifecycle
  const event = state.outbox.find(e => e.id === id)!;
  const entries = timeline(B, event.aggregateId);
  assert.ok(entries.some(e => e.entityId === id && e.action === 'outbox.published'));
  assert.ok(entries.some(e => e.entityId === id && e.action === 'outbox.publish_failed'));
  // other tenant cannot read the order timeline behind the event
  assert.throws(() => timeline(A, event.aggregateId));
});
