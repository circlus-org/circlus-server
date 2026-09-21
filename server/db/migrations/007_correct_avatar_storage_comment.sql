-- Avatar blobs are opaque to the server. Current clients encrypt Circle
-- avatars before upload and distribute the blob reference inside the signed,
-- encrypted Circle profile.

COMMENT ON COLUMN identities.avatar_blob_id IS
  'Opaque blob ID of the client-encrypted Circle avatar';
