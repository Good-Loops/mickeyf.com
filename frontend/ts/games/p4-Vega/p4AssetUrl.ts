/** Resolve before Pixi's HTTP-only root handling can drop a custom scheme's host. */
export function resolveP4AssetUrl(source: string, baseUrl: string): string {
    return new URL(source, baseUrl).href;
}
