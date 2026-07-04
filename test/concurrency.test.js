// Unit tests for the concurrency semaphore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/concurrency.js';

test('unlimited (max=0) never blocks', async () => {
  const s = new Semaphore(0);
  assert.equal(s.available, Infinity);
  let ran = 0;
  await Promise.all([s.run(() => (ran++, 1)), s.run(() => (ran++, 2))]);
  assert.equal(ran, 2);
});

test('limits concurrency and releases slots', async () => {
  const s = new Semaphore(2);
  let active = 0;
  let maxObserved = 0;
  const task = () =>
    s.run(async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  await Promise.all(Array.from({ length: 10 }, () => task()));
  assert.equal(maxObserved, 2);
  assert.equal(s.active, 0);
  assert.equal(s.queue.length, 0);
});

test('releases slot even when fn throws', async () => {
  const s = new Semaphore(1);
  await assert.rejects(() => s.run(() => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(s.active, 0);
  assert.equal(s.available, 1);
});
