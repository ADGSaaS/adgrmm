# Security keys

The backend keeps two key files outside the database. Neither is in any backup it makes, so back them up yourself, separately from the backups they protect.

| File | Set by | Protects | Lost without a copy |
| --- | --- | --- | --- |
| `/opt/remoteiq/secrets/job-signing.pem` | `JOB_SIGNING_KEY_FILE` | Signs every script, file job, update and remote session start that agents accept | Every agent refuses the server until the installer is run on it again |
| `/opt/remoteiq/secrets/data-encryption.key` | `DATA_ENCRYPTION_KEY_FILE` | Encrypts stored credentials and encrypted backup archives | Stored credentials must be entered again, and **encrypted backup archives can never be read** |

The data key encrypts SMTP, IMAP and POP passwords, storage connection secrets and DKIM private keys.

## Backing them up

Copy both files somewhere that does not hold the backups and the database, such as a password manager or an offline encrypted drive. A thief who has the data key and a database dump or archive can read everything in them.

Keep them readable only by the backend's user (`chmod 600`). Check that a copy can be read back, and keep it when a key changes: older archives need the key they were made with.

## Restoring

- **A PostgreSQL backup.** Stored credentials stay encrypted inside the dump, so the restored server needs the same data key. If the key is wrong, the backend still starts and logs how many secrets it cannot decrypt, and features that need them fail until the key is corrected or the secrets are entered again.
- **An encrypted archive.** The restore worker decrypts it with the current data key. To decrypt one by hand, for example before the backend is running, use the same key:

  ```
  DATA_ENCRYPTION_KEY_FILE=/opt/remoteiq/secrets/data-encryption.key \
    node backend/scripts/decrypt-backup.cjs backup.dump.enc backup.dump
  ```

## Changing the data key

There is no rotation command yet. Replacing the file makes existing secrets and encrypted archives unreadable.
