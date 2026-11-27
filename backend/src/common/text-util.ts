// backend/src/common/text-util.ts
//
// Small string helpers that run in linear time. They replace regular expressions such as /\/+$/ and /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
// which can take quadratic time on a long run of the repeated character (a 100,000 character "////...x" costs about 5 billion steps).

/** Removes every trailing occurrence of one character. */
export function trimTrailing(s: string, ch: string): string {
    let end = s.length;
    while (end > 0 && s[end - 1] === ch) end--;
    return end === s.length ? s : s.slice(0, end);
}

/** Removes every leading occurrence of one character. */
export function trimLeading(s: string, ch: string): string {
    let start = 0;
    while (start < s.length && s[start] === ch) start++;
    return start === 0 ? s : s.slice(start);
}

/** Longest address accepted anywhere (RFC 5321 allows 254 characters). */
export const MAX_EMAIL_LENGTH = 254;

/**
 * True for "name@host.tld": one "@", no white space, something before it, and a dot inside the part after it that has at least one
 * character on each side (minTld characters at the end). Same answer as /^[^@\s]+@[^@\s]+\.[^@\s]{minTld,}$/ for any input up to
 * MAX_EMAIL_LENGTH characters, in linear time, and longer input is refused.
 */
export function looksLikeEmail(value: unknown, minTld = 1): boolean {
    if (typeof value !== "string" || value.length > MAX_EMAIL_LENGTH) return false;
    const at = value.indexOf("@");
    if (at < 1 || value.indexOf("@", at + 1) !== -1) return false;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) return false;
    }
    const host = value.slice(at + 1);
    // a dot with at least one character before it and minTld characters after it
    return host.slice(1, host.length - minTld).includes(".");
}

/** Removes every leading and trailing occurrence of one character. */
export function trimBoth(s: string, ch: string): string {
    return trimTrailing(trimLeading(s, ch), ch);
}
