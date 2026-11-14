type ApiBaseOptions = {
    mode: string;
    isNative: boolean;
    developmentUrl: string;
    productionUrl: string;
    publicPreview?: boolean;
};

/** Hosted browsers use first-party cookies; native requests keep their API origin. */
export function selectApiBase({ mode, isNative, developmentUrl, productionUrl, publicPreview = false }: ApiBaseOptions): string {
    if (mode === 'development' && !isNative && publicPreview) return '/__public-api';
    if (mode === 'development') return developmentUrl;
    return isNative ? productionUrl : '';
}
