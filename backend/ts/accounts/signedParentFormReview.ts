import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

const timeout = 10_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export type SignedFormReview = Readonly<{ reference: string; parentAccountId: string; verifiedContact: string;
    policyDigest: Buffer; formSha256: Buffer; reviewer: string; decision: 'approved' | 'rejected'; publicApproved: boolean }>;

export async function cleanupSignedParentForms(database: Pick<Pool, 'query'>): Promise<{ backlog: boolean }> {
    for (let batch = 0; batch < 10; batch++) {
        const [result] = await database.query<ResultSetHeader>({ sql: "DELETE FROM parent_signed_forms WHERE status <> 'used' AND expires_at<=UTC_TIMESTAMP(6) LIMIT 100", timeout });
        if (!Number.isInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > 100) throw new Error('Signed form cleanup is unavailable.');
        if (result.affectedRows < 100) return { backlog: false };
    }
    const [rows] = await database.query<RowDataPacket[]>({ sql: "SELECT reference FROM parent_signed_forms WHERE status <> 'used' AND expires_at<=UTC_TIMESTAMP(6) LIMIT 1", timeout });
    return { backlog: rows.length !== 0 };
}

/** Administrative credentials only. The HTTP runtime cannot write review evidence or approve public permission. */
export async function reviewSignedParentForm(database: Pick<Pool, 'getConnection'>, review: SignedFormReview): Promise<void> {
    if (!uuid.test(review.reference) || !uuid.test(review.parentAccountId) || !review.verifiedContact
        || review.verifiedContact.length > 254 || !/^[\x20-\x7e]{1,128}$/u.test(review.reviewer)
        || !Buffer.isBuffer(review.policyDigest) || review.policyDigest.length !== 32
        || !Buffer.isBuffer(review.formSha256) || review.formSha256.length !== 32
        || !['approved', 'rejected'].includes(review.decision) || typeof review.publicApproved !== 'boolean'
        || (review.decision === 'rejected' && review.publicApproved)) throw new TypeError('Invalid signed form review.');
    const connection = await database.getConnection();
    let phase: 'before' | 'active' | 'commit' | 'done' = 'before';
    try {
        await connection.query({ sql: 'START TRANSACTION', timeout }); phase = 'active';
        const [forms] = await connection.query<RowDataPacket[]>({ sql: `SELECT reference, public_policy_digest FROM parent_signed_forms
            WHERE reference=? AND parent_uuid=? AND BINARY verified_contact=BINARY ? AND policy_digest=?
            AND status='pending' AND expires_at>UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE`, timeout },
        [review.reference, review.parentAccountId, review.verifiedContact, review.policyDigest]);
        if (forms.length !== 1 || (review.publicApproved && !Buffer.isBuffer(forms[0].public_policy_digest))) throw new Error('The exact pending signed form request is unavailable.');
        const [result] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_signed_forms SET status=?, reviewed_at=UTC_TIMESTAMP(6),
            reviewer=?, form_sha256=?, public_approved=? WHERE reference=? AND status='pending'`, timeout },
        [review.decision, review.reviewer, review.formSha256, review.publicApproved ? 1 : 0, review.reference]);
        if (result.affectedRows !== 1) throw new Error('Signed form review was not applied.');
        phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout }); phase = 'done';
    } catch (error) {
        if (phase === 'active') {
            try { await connection.query({ sql: 'ROLLBACK', timeout }); }
            catch { connection.destroy(); }
        } else if (phase !== 'done') connection.destroy();
        throw error;
    } finally { connection.release(); }
}
