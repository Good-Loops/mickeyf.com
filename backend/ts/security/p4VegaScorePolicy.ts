/**
 * Server-side score policy for p4-Vega.
 *
 * Current gameplay adds 10 points per water pickup and preallocates 100 unique
 * black-hole hazards. One hazard is created before play begins and every pickup
 * consumes another before incrementing the score. That makes 0..990
 * (inclusive), in steps of 10, the score space the current client can produce.
 */
export const P4_VEGA_SCORE_INCREMENT = 10;
export const P4_VEGA_MAX_SCORE = 990;

export function isValidP4VegaScore(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && (value as number) >= 0
        && (value as number) <= P4_VEGA_MAX_SCORE
        && (value as number) % P4_VEGA_SCORE_INCREMENT === 0;
}
