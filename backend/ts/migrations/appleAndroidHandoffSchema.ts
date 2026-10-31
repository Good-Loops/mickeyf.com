import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

export const APPLE_ANDROID_HANDOFF_MIGRATION = '0027_create_apple_android_handoffs';
const TABLE = 'apple_android_handoffs';
const CHECKS = [
    ['chk_apple_android_handoff_client', "(cast(client_keyascharcharsetbinary)=cast('apple-android'ascharcharsetbinary))"],
    ['chk_apple_android_handoff_lifetime', '((expires_at>created_at)and(expires_at<=(created_at+interval300second)))'],
    ['chk_apple_android_handoff_phase', "(((phase='pending')and(encrypted_credentialisnull))or((phase='ready')and(encrypted_credentialisnotnull)and(length(encrypted_credential)>31)))"],
    ['chk_apple_android_handoff_target', "(((cast(actionascharcharsetbinary)in(cast('login'ascharcharsetbinary),cast('signup'ascharcharsetbinary)))and(account_uuidisnull)and(user_idisnull))or((cast(actionascharcharsetbinary)in(cast('link'ascharcharsetbinary),cast('delete'ascharcharsetbinary)))and(account_uuidisnotnull)and(user_idisnotnull)and(user_id>0)))"],
];

async function rows(connection: MigrationConnection, sql: string, values: unknown[] = [TABLE]) {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error();
    return result.map(row => ({ ...row })) as Record<string, unknown>[];
}
function exact(actual: unknown, expected: unknown) { if (!isDeepStrictEqual(actual, expected)) throw new Error(); }
function unavailable() { return new Error('Apple Android handoff schema is not ready.'); }
function normalizeCheck(clause: unknown): string {
    if (typeof clause !== 'string') throw new Error();
    const source = clause.replace(/\\/gu, '');
    let quoted = false;
    let result = '';
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (!quoted) {
            const introducer = /^_(?:ascii|utf8mb4)(?=')/u.exec(source.slice(index));
            if (introducer) { index += introducer[0].length - 1; continue; }
            if (character === '`' || /\s/u.test(character)) continue;
        }
        result += character;
        if (character === "'") {
            if (quoted && source[index + 1] === "'") { result += source[++index]; }
            else quoted = !quoted;
        }
    }
    if (quoted) throw new Error();
    return result;
}

/** Boot/maintenance invoke only with the Android opt-in; this performs no DDL, grants, or migration registration. */
export async function verifyAppleAndroidHandoffSchema(connection: MigrationConnection): Promise<void> {
    try {
        exact(await rows(connection, `SELECT ENGINE AS engine,TABLE_COLLATION AS collation,TABLE_TYPE AS type
            FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`),
        [{ engine:'InnoDB',collation:'utf8mb4_unicode_ci',type:'BASE TABLE' }]);
        const column = (name: string,type: string,ascii=false,nullable='NO',comment='') => ({
            name,type,nullable,charset:ascii?'ascii':null,collation:ascii?'ascii_bin':null,
            defaultValue:null,extra:'',generation:'',comment,
        });
        exact(await rows(connection, `SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra,GENERATION_EXPRESSION AS generation,COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`), [
            column('state_hash','binary(32)'),column('binding_hash','binary(32)'),column('nonce','char(43)',true),
            column('client_key','varchar(64)',true),column('action','varchar(8)',true),
            column('account_uuid','char(36)',true,'YES'),column('user_id','int',false,'YES'),
            column('phase',"enum('pending','ready')",true),column('encrypted_credential','varbinary(24576)',false,'YES'),
            column('created_at','datetime(6)',false,'NO','UTC'),column('expires_at','datetime(6)',false,'NO','UTC'),
        ]);
        const index = (name:string,column:string,nonUnique:number) => ({name,column,nonUnique,sequence:1,
            subPart:null,visible:'YES',type:'BTREE',direction:'A'});
        exact(await rows(connection, `SELECT INDEX_NAME AS name,COLUMN_NAME AS \`column\`,NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence,SUB_PART AS subPart,IS_VISIBLE AS visible,INDEX_TYPE AS type,COLLATION AS direction
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`), [
            index('idx_apple_android_handoff_expiry','expires_at',1),index('PRIMARY','state_hash',0),
            index('uq_apple_android_handoff_binding','binding_hash',0),
        ]);
        exact(await rows(connection, `SELECT c.CONSTRAINT_NAME AS name,c.ENFORCED AS enforced,d.CHECK_CLAUSE AS clause
            FROM information_schema.TABLE_CONSTRAINTS c JOIN information_schema.CHECK_CONSTRAINTS d
            ON d.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND d.CONSTRAINT_NAME=c.CONSTRAINT_NAME
            WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME=? AND c.CONSTRAINT_TYPE='CHECK' ORDER BY c.CONSTRAINT_NAME`)
            .then(result=>result.map(row=>({...row,clause:normalizeCheck(row.clause)}))),
        CHECKS.map(([name,clause])=>({name,enforced:'YES',clause})));
        exact(await rows(connection, `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='FOREIGN KEY'`),
        [{name:'fk_apple_android_handoff_attempt'}]);
        exact(await rows(connection, `SELECT k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS \`column\`,k.ORDINAL_POSITION AS sequence,
            (k.REFERENCED_TABLE_SCHEMA=DATABASE()) AS sameSchema,k.REFERENCED_TABLE_NAME AS targetTable,
            k.REFERENCED_COLUMN_NAME AS targetColumn,r.UPDATE_RULE AS updateRule,r.DELETE_RULE AS deleteRule
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`),
        [{name:'fk_apple_android_handoff_attempt',column:'state_hash',sequence:1,sameSchema:1,targetTable:'provider_auth_attempts',
            targetColumn:'state_hash',updateRule:'RESTRICT',deleteRule:'CASCADE'}]);
        exact(await rows(connection, `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?`),[]);
    } catch { throw unavailable(); }
}

export async function verifyAppleAndroidHandoffReadiness(connection: MigrationConnection): Promise<void> {
    try {
        exact(await rows(connection,'SELECT version FROM schema_migrations WHERE version=?',[APPLE_ANDROID_HANDOFF_MIGRATION]),
            [{version:APPLE_ANDROID_HANDOFF_MIGRATION}]);
        await verifyAppleAndroidHandoffSchema(connection);
    } catch { throw unavailable(); }
}
