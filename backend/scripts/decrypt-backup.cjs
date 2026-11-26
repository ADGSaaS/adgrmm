#!/usr/bin/env node
// Decrypts an encrypted backup archive by hand, for when the backend is not running or a downloaded
// archive has to be read. It needs the build in dist/ and the key the archive was made with.
//
//   DATA_ENCRYPTION_KEY_FILE=/opt/adgrmm/secrets/data-encryption.key \
//     node scripts/decrypt-backup.cjs <input> <output>
"use strict";

const path = require("node:path");

const [input, output] = process.argv.slice(2);
if (!input || !output) {
    console.error("Usage: node scripts/decrypt-backup.cjs <input> <output>");
    process.exit(2);
}

const { decryptArchiveFile } = require(path.join(__dirname, "..", "dist", "backups", "archive-crypto"));

decryptArchiveFile(input, output).then(
    () => console.log(`Decrypted to ${output}`),
    (e) => {
        console.error(e.message);
        process.exit(1);
    },
);
