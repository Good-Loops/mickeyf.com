import { useLayoutEffect } from 'react';
import { nativePresentation } from '@/services/nativePresentation';

/** Route disposal must never preserve a previous game's rotation lease. */
export function useNativePresentation(pathname: string): void {
    // Reset before the destination's passive effects acquire their new fullscreen leases.
    useLayoutEffect(() => {
        nativePresentation.reset();
        return () => nativePresentation.reset();
    }, [pathname]);
}
