/** Public notice links never carry credentials, query data or ambiguous URL syntax. */
export function parsePrivacyNoticeUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^/?#@]+(?:[\/#]|$)/u.test(value)
        || /[\s\u0000-\u001f\u007f\\]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search
            || value.includes('?') || (url.port && url.port !== '443')) return undefined;
        return url.href;
    } catch { return undefined; }
}
