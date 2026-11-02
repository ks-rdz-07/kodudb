//! Secrets at rest are encrypted with AES-256 (OpenPGP symmetric encryption through pgcrypto, key derived
//! from ENCRYPTION_KEY with iterated and salted SHA-256). Every `pgp_sym_encrypt` call passes `PGP_OPTIONS`;
//! values written by older versions with AES-128 are re-encrypted once at start-up.
use sqlx::PgPool;

/// pgcrypto options for every encrypted value.
pub const PGP_OPTIONS: &str = "cipher-algo=aes256, s2k-digest-algo=sha256";

/// Encrypted columns in the platform database only.
pub const PLATFORM_COLUMNS: &[(&str, &str)] = &[
    ("platform.projects", "jwt_secret_enc"),
    ("platform.projects", "github_token_enc"),
    ("platform.projects", "owner_password_enc"),
    ("platform.projects", "storage_secret_enc"),
];

/// Encrypted columns in every project database (the default project lives in the platform database).
pub const PROJECT_COLUMNS: &[(&str, &str)] = &[
    ("auth.settings", "smtp_pass_enc"),
    ("auth.mfa_factors", "secret_enc"),
    ("auth.oauth_providers", "client_secret_enc"),
    ("kodudb.connections", "url_encrypted"),
];

/// Re-encrypt values that are not yet AES-256. In OpenPGP's symmetric-key packet (what pgcrypto writes),
/// byte 3 is the cipher id: 7 is AES-128, 9 is AES-256. Run it on a connection with triggers off
/// (session_replication_role = replica) so the change log and live events never see secret columns.
/// Each column is its own statement: a value that cannot be decrypted leaves that column as it was.
pub async fn upgrade_columns(pool: &PgPool, key: &str, columns: &[(&str, &str)]) -> u64 {
    let mut total = 0;
    for (table, column) in columns {
        let sql = format!(
            "update {table} set {column} = pgp_sym_encrypt(pgp_sym_decrypt({column}, $1), $1, '{PGP_OPTIONS}')
             where {column} is not null and get_byte({column}, 3) <> 9"
        );
        match sqlx::query(sqlx::AssertSqlSafe(sql)).bind(key).execute(pool).await {
            Ok(r) => total += r.rows_affected(),
            Err(e) => eprintln!("re-encrypting {table}.{column} with AES-256 failed: {e}"),
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::PGP_OPTIONS;

    /// Every pgp_sym_encrypt call in the API must pass the AES-256 options.
    #[test]
    fn every_encryption_uses_aes256() {
        let sources = [
            include_str!("connect.rs"),
            include_str!("mail.rs"),
            include_str!("mfa.rs"),
            include_str!("oauth.rs"),
            include_str!("objects.rs"),
            include_str!("owner.rs"),
            include_str!("platform.rs"),
            include_str!("secrets.rs"),
            include_str!("auth.rs"),
            include_str!("github.rs"),
        ];
        let mut calls = 0;
        for src in sources {
            for (i, _) in src.match_indices("pgp_sym_encrypt(") {
                let call = &src[i..src[i..].find('\n').map_or(src.len(), |n| i + n)];
                if call.contains("pgp_sym_encrypt(pgp_sym_decrypt") {
                    continue; // the re-encryption statement in this module's style
                }
                calls += 1;
                assert!(call.contains(PGP_OPTIONS), "pgp_sym_encrypt without AES-256 options: {call}");
            }
        }
        assert!(calls >= 10, "expected the known encryption sites, found {calls}");
    }
}
