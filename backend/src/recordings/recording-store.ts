// backend/src/recordings/recording-store.ts
//
// Where recorded sessions are kept: one folder per recording on the server's disk, one file per uploaded piece.
// Every piece is encrypted by itself (AES-256-GCM, a key derived from DATA_ENCRYPTION_KEY with a fresh salt), and the
// recording id and the piece's position are authenticated with it, so a piece cannot be swapped between recordings,
// reordered or edited without playback failing. A browser that crashes loses nothing already uploaded, because each
// piece is complete on its own.
//
//   piece file:  magic (8) | salt (16) | nonce (12) | ciphertext | GCM tag (16)
//
// The plain size of a piece is its file size minus the 52 bytes of framing, so sizes and byte ranges are known
// without opening anything.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { deriveDataKey } from "../common/secret-box";

const MAGIC = Buffer.from("RIQREC1\n", "latin1");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const PIECE_OVERHEAD = MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES;
const KEY_INFO = "remoteiq-session-recording-v1";

export function recordingsRoot(): string {
    const base = process.env.RECORDINGS_DIR?.trim() || join(process.env.ADMIN_DATA_DIR?.trim() || join(process.cwd(), "var"), "recordings");
    return base;
}

const pieceName = (seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("Invalid recording piece number.");
    return `${String(seq).padStart(8, "0")}.piece`;
};
const aad = (recordingId: string, seq: number) => Buffer.from(`${recordingId}:${seq}`, "utf8");

export function sealPiece(recordingId: string, seq: number, plain: Buffer): Buffer {
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", deriveDataKey(salt, KEY_INFO), nonce);
    cipher.setAAD(aad(recordingId, seq));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC, salt, nonce, body, cipher.getAuthTag()]);
}

export function openPiece(recordingId: string, seq: number, sealed: Buffer): Buffer {
    if (sealed.length < PIECE_OVERHEAD || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("The recording piece is damaged.");
    let o = MAGIC.length;
    const salt = sealed.subarray(o, (o += SALT_BYTES));
    const nonce = sealed.subarray(o, (o += NONCE_BYTES));
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const body = sealed.subarray(o, sealed.length - TAG_BYTES);
    try {
        const decipher = createDecipheriv("aes-256-gcm", deriveDataKey(salt, KEY_INFO), nonce);
        decipher.setAAD(aad(recordingId, seq));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
        throw new Error("The recording piece is damaged or was made with another encryption key.");
    }
}

/** The folder of one recording. The id is checked, so it can never point outside the recordings folder. */
export function recordingDir(recordingId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordingId)) throw new Error("Invalid recording id.");
    const root = resolve(recordingsRoot());
    const dir = resolve(root, recordingId.toLowerCase());
    // The id pattern above already rules out separators and "..", this is the second, independent check that the folder is inside the root.
    if (!dir.startsWith(root + sep)) throw new Error("Invalid recording id.");
    return dir;
}

export async function writePiece(recordingId: string, seq: number, plain: Buffer): Promise<void> {
    const dir = recordingDir(recordingId);
    await fsp.mkdir(dir, { recursive: true });
    const file = join(dir, pieceName(seq));
    const tmp = `${file}.tmp`;
    // Written aside and renamed, so a crash never leaves a half piece that looks complete.
    await fsp.writeFile(tmp, sealPiece(recordingId, seq, plain), { mode: 0o600 });
    await fsp.rename(tmp, file);
}

/** Plain sizes of the pieces that exist, in order, from file sizes alone. Stops at the first gap. */
export async function pieceSizes(recordingId: string, count: number): Promise<number[]> {
    const dir = recordingDir(recordingId);
    const sizes: number[] = [];
    for (let seq = 0; seq < count; seq++) {
        try {
            const st = await fsp.stat(join(dir, pieceName(seq)));
            sizes.push(Math.max(0, Number((st as any).size) - PIECE_OVERHEAD));
        } catch {
            break;
        }
    }
    return sizes;
}

export async function readPiece(recordingId: string, seq: number): Promise<Buffer> {
    const sealed = (await fsp.readFile(join(recordingDir(recordingId), pieceName(seq)))) as Buffer;
    return openPiece(recordingId, seq, sealed);
}

export async function removeRecordingFiles(recordingId: string): Promise<void> {
    await fsp.rm(recordingDir(recordingId), { recursive: true, force: true });
}
