/**
 * Published SQL stays immutable. One audited exception bridges a comment-only
 * edit in 018 (a7aaa645); both byte-for-byte hashes are fixed here. Keep the
 * originally recorded checksum for audit, never rerun DDL or normalize history.
 */
export function appliedMigrationChecksumMatch(
  version: string,
  recordedChecksum: string,
  fileChecksum: string
): 'exact' | 'known_comment_only_change' | null {
  if (recordedChecksum === fileChecksum) return 'exact';
  if (version === '018_device_client_protocols.sql'
    && recordedChecksum === '68df1ed1a05963ce74f6699aaccc61b091d6cb8d9114a7b0944275377da98899'
    && fileChecksum === '192d03fdfccc7b5e9723ff3c3ba9dd76d466bee52143d089c3b293446ef7d6d6') {
    return 'known_comment_only_change';
  }
  return null;
}
