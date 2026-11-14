import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { signedFormNoticeDigest } from './signedParentForm';

const notice = require('../../../shared/privacyNotice.json');
const digest = (value: typeof notice) => createHash('sha256').update(JSON.stringify([
    value.version, value.operatorName, value.contactEmail, value.operatorAddress, value.operatorTelephone,
    value.signedParentForm, value.availabilityText, value.sections, value.ptBR,
])).digest('hex');

test('signed form digest binds Portuguese notice, consent translations and labels', () => {
    const baseline = digest(notice);
    assert.equal(signedFormNoticeDigest().toString('hex'), baseline);
    for (const field of ['notice', 'parentConsent', 'publicConsent'] as const) {
        const changed = structuredClone(notice);
        changed.signedParentForm.ptBR[field] += ' changed';
        assert.notEqual(digest(changed), baseline, field);
    }
    const changed = structuredClone(notice);
    changed.signedParentForm.ptBR.labels.signature += ' changed';
    assert.notEqual(digest(changed), baseline);
    for (const language of ['sections', 'ptBR'] as const) {
        const revision = structuredClone(notice);
        if (language === 'sections') revision.sections[0].text += ' changed';
        else revision.ptBR.sections[0].text += ' changed';
        assert.notEqual(digest(revision), baseline, `${language} privacy notice`);
    }
});
