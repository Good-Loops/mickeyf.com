import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePrivacyNoticeUrl } from './privacyNoticeUrl.ts';

test('privacy notice URL accepts HTTPS documents and section links without sending user data', () => {
    assert.equal(parsePrivacyNoticeUrl('https://notice.example.test/privacy'), 'https://notice.example.test/privacy');
    assert.equal(parsePrivacyNoticeUrl('https://NOTICE.example.test:443/privacy#children'), 'https://notice.example.test/privacy#children');
});
test('privacy notice URL rejects missing, executable, credential-bearing and ambiguous destinations', () => {
    for (const value of [undefined, null, 42, '', '/privacy', '//notice.example.test/privacy', 'javascript:alert(1)',
        'data:text/html,test', 'http://notice.example.test/privacy', 'https://', 'https:////notice.example.test',
        'https://@notice.example.test', 'https://u:p@notice.example.test/privacy',
        'https://notice.example.test/privacy?child=123', 'https://notice.example.test/privacy?',
        'https://notice.example.test:8443/privacy', ' https://notice.example.test/privacy',
        'https://notice.example.test/pri\nvacy', 'https://notice.example.test\\@other.example.test/privacy',
        'https://notice.example.test/%0aprivacy', `https://notice.example.test/${'a'.repeat(2048)}`]) {
        assert.equal(parsePrivacyNoticeUrl(value), undefined, String(value));
    }
});
