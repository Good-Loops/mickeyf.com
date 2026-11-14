import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalProviderMaintenance } from './localProviderMaintenance';

function pending<T>() {
    let resolve!: (value: T) => void;
    return { promise: new Promise<T>(complete => { resolve = complete; }), resolve: (value: T) => resolve(value) };
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('local maintenance is unavailable until its first actual successful pass and never overlaps', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const first = pending<number>();
    let calls = 0;
    const runner = createLocalProviderMaintenance(() => { calls++; return first.promise; }, { intervalMs: 1_000 });
    assert.equal(calls, 0);
    assert.equal(runner.isHealthy(), false);
    const starting = runner.start();
    await settle();
    assert.equal(calls, 1);
    assert.equal(runner.isHealthy(), false);
    context.mock.timers.tick(10_000);
    await settle();
    assert.equal(calls, 1);
    first.resolve(0);
    await starting;
    assert.equal(runner.isHealthy(), true);
    await runner.stop();
    assert.equal(runner.isHealthy(), false);
    context.mock.timers.tick(100_000);
    await settle();
    assert.equal(calls, 1);
});

test('failed and stale maintenance closes Apple issuance while later successful passes recover readiness', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let result = 1;
    let reports = 0;
    let clock = 1;
    const runner = createLocalProviderMaintenance(async () => result,
        { intervalMs: 1_000, now: () => clock, reportUnavailable: () => { reports++; } });
    await runner.start();
    assert.equal(runner.isHealthy(), false);
    assert.equal(reports, 1);
    result = 0;
    context.mock.timers.tick(1_000);
    await settle();
    assert.equal(runner.isHealthy(), true);
    clock += 121_001;
    assert.equal(runner.isHealthy(), false);
    context.mock.timers.tick(1_000);
    await settle();
    assert.equal(runner.isHealthy(), true);
    await runner.stop();
});

test('stopping waits for owned work and cannot restart it or leak private failures', async () => {
    const work = pending<number>();
    const runner = createLocalProviderMaintenance(() => work.promise);
    const starting = runner.start();
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await settle();
    assert.equal(stopped, false);
    work.resolve(0);
    await starting; await stopping;
    assert.equal(runner.isHealthy(), false);
    await assert.rejects(runner.start(), /has stopped/);
    let reports = 0;
    const failed = createLocalProviderMaintenance(async () => { throw new Error('synthetic-private-details'); },
        { reportUnavailable: () => { reports++; } });
    await failed.start();
    assert.equal(failed.isHealthy(), false); assert.equal(reports, 1);
    await failed.stop();
});

test('a hung initial pass lets HTTP preparation finish unavailable without overlapping or trusting its late result', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const work = pending<number>();
    let calls = 0;
    let reports = 0;
    const runner = createLocalProviderMaintenance(() => ++calls === 1 ? work.promise : Promise.resolve(0),
        { intervalMs: 1_000, maxPassMs: 2_000, reportUnavailable: () => { reports++; } });
    const starting = runner.start();
    await settle();
    context.mock.timers.tick(2_000);
    await starting;
    assert.equal(runner.isHealthy(), false);
    assert.equal(reports, 1);
    context.mock.timers.tick(20_000);
    await settle();
    assert.equal(calls, 1, 'ambiguous work must not be retried or overlapped');
    work.resolve(0);
    await settle();
    assert.equal(runner.isHealthy(), false, 'a late success cannot reopen issuance');
    context.mock.timers.tick(1_000);
    await settle();
    assert.equal(calls, 2);
    assert.equal(runner.isHealthy(), true, 'only a fresh completed pass can restore readiness');
    await runner.stop();
});
