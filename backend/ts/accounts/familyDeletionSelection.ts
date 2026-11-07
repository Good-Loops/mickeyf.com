import { createHash } from 'node:crypto';
import { isAccountId } from './deletionJournal';

/** The confirmation names account incarnations, never mutable nicknames or a future family. */
export function familySelectionDigest(value: unknown): Buffer | null {
    if (!Array.isArray(value) || value.length > 50 || value.some(id => !isAccountId(id))
        || new Set(value).size !== value.length) return null;
    return createHash('sha256').update(JSON.stringify([...value].sort())).digest();
}
