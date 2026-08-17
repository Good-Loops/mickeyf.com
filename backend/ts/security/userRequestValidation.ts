export type SignupInput = {
    userName: string;
    email: string;
    password: string;
};

export type LoginInput = {
    userName: string;
    password: string;
};

export type SignupValidation =
    | { valid: true; input: SignupInput }
    | { valid: false; error: 'EMPTY_FIELDS' | 'INVALID_USERNAME' | 'INVALID_EMAIL' | 'INVALID_PASSWORD' };

export type LoginValidation =
    | { valid: true; input: LoginInput }
    | { valid: false };

const USER_NAME_MAX_LENGTH = 64;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 8;
// bcrypt only incorporates the first 72 UTF-8 bytes. Reject longer inputs so
// distinct passphrases cannot silently collapse to the same effective secret.
const PASSWORD_MAX_BYTES = 72;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function operationType(body: unknown): string | null {
    if (!isRecord(body) || typeof body.type !== 'string') return null;
    return body.type;
}

export function validateSignupRequest(body: unknown): SignupValidation {
    if (!isRecord(body)) return { valid: false, error: 'EMPTY_FIELDS' };

    const { user_name, email, user_password } = body;
    if (
        typeof user_name !== 'string'
        || typeof email !== 'string'
        || typeof user_password !== 'string'
        || user_name.trim() === ''
        || email.trim() === ''
        || user_password === ''
    ) {
        return { valid: false, error: 'EMPTY_FIELDS' };
    }

    const normalizedUserName = user_name.trim();
    const normalizedEmail = email.trim().toLowerCase();

    if (
        normalizedUserName.length > USER_NAME_MAX_LENGTH
        || CONTROL_CHARACTERS.test(normalizedUserName)
    ) {
        return { valid: false, error: 'INVALID_USERNAME' };
    }

    if (
        normalizedEmail.length > EMAIL_MAX_LENGTH
        || !BASIC_EMAIL.test(normalizedEmail)
        || CONTROL_CHARACTERS.test(normalizedEmail)
    ) {
        return { valid: false, error: 'INVALID_EMAIL' };
    }

    if (
        user_password.length < PASSWORD_MIN_LENGTH
        || Buffer.byteLength(user_password, 'utf8') > PASSWORD_MAX_BYTES
        || CONTROL_CHARACTERS.test(user_password)
    ) {
        return { valid: false, error: 'INVALID_PASSWORD' };
    }

    return {
        valid: true,
        input: {
            userName: normalizedUserName,
            email: normalizedEmail,
            password: user_password,
        },
    };
}

export function validateLoginRequest(body: unknown): LoginValidation {
    if (!isRecord(body)) return { valid: false };

    const { user_name, user_password } = body;
    if (
        typeof user_name !== 'string'
        || typeof user_password !== 'string'
        || user_name.trim() === ''
        || user_name.length > USER_NAME_MAX_LENGTH
        || user_password.length < 1
        || Buffer.byteLength(user_password, 'utf8') > PASSWORD_MAX_BYTES
        || CONTROL_CHARACTERS.test(user_name)
        || CONTROL_CHARACTERS.test(user_password)
    ) {
        return { valid: false };
    }

    return {
        valid: true,
        input: {
            userName: user_name.trim(),
            password: user_password,
        },
    };
}
