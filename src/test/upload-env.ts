// Imported FIRST by upload.test.ts so these exist before the server's config is read.
Object.assign(process.env, { R2_S3_API_URL: 'https://acct.r2.cloudflarestorage.com', R2_API_KEY_ID: 'AKIATESTKEY', R2_API_ACCESS_TOKEN: 'secret-token-value', BUCKET_NAME: 'media', STORAGE_URL: 'https://files.example.com' });
