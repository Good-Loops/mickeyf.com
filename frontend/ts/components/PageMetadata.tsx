import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { getPageMetadata, type PageMetadata as Metadata } from '@/config/pageMetadata';

export function applyPageMetadata(page: Document, metadata: Metadata): void {
    const setMeta = (attribute: 'name' | 'property', key: string, content: string | undefined) => {
        let element = page.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
        if (content === undefined) { element?.remove(); return; }
        if (!element) { element = page.createElement('meta'); element.setAttribute(attribute, key); page.head.append(element); }
        element.content = content;
    };
    // Keep the browser title stable, including on mobile and during navigation.
    page.title = 'Ludolume';
    setMeta('name', 'description', metadata.description);
    setMeta('name', 'robots', metadata.robots);
    setMeta('property', 'og:title', metadata.title);
    setMeta('property', 'og:description', metadata.description);
    setMeta('property', 'og:url', metadata.canonical);
    setMeta('name', 'twitter:title', metadata.title);
    setMeta('name', 'twitter:description', metadata.description);
    let canonical = page.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!metadata.canonical) canonical?.remove();
    else {
        if (!canonical) { canonical = page.createElement('link'); canonical.rel = 'canonical'; page.head.append(canonical); }
        canonical.href = metadata.canonical;
    }
}

export default function PageMetadata({ threeBossesAvailable }: { threeBossesAvailable: boolean }) {
    const { pathname } = useLocation();
    useEffect(() => {
        if (!Capacitor.isNativePlatform()) applyPageMetadata(document, getPageMetadata(pathname, threeBossesAvailable));
    }, [pathname, threeBossesAvailable]);
    return null;
}
