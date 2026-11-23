import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('image uploads when the bucket is not configured', () => {
  it('says so clearly instead of failing obscurely', async () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/none';
    process.env.JWT_SECRET = 'test-secret-test-secret-123456';
    for (const k of ['R2_S3_API_URL', 'R2_API_KEY_ID', 'R2_API_ACCESS_TOKEN', 'BUCKET_NAME', 'STORAGE_URL']) process.env[k] = ''; // set (not deleted) so a developer's real .env can't fill them back in
    const { presignImageUpload, storageConfigured, isStoredUrl } = await import('../services/storage.service');
    assert.equal(storageConfigured(), false);
    await assert.rejects(() => presignImageUpload('product', 'png'), (e: any) => e.status === 503 && /not set up/.test(e.message));
    assert.equal(isStoredUrl('https://files.example.com/a.png'), false, 'no picture is accepted until storage is configured');
  });
});
