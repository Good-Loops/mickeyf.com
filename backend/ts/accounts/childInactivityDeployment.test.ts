import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { ChildInactivityDeployment } from '../config/childInactivityDeployment';
import { prepareChildInactivityDeployment } from './childInactivityDeployment';

test('direct production composition fails closed before any database or journal access without independent activity history', async () => {
    let touched = false;
    const database = { getConnection: () => { touched = true; throw new Error('unexpected'); } } as unknown as Pool;
    await assert.rejects(prepareChildInactivityDeployment(database, {} as ChildInactivityDeployment), /independent activity continuity/u);
    assert.equal(touched, false);
});
