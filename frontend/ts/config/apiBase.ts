type ApiBaseOptions = {
    mode: string;
    isNative: boolean;
    developmentUrl: string;
    productionUrl: string;
};

/** Hosted browsers use first-party cookies; native requests keep their API origin. */
export function selectApiBase({ mode, isNative, developmentUrl, productionUrl }: ApiBaseOptions): string {
    if (mode === 'development') return developmentUrl;
    return isNative ? productionUrl : '';
}
