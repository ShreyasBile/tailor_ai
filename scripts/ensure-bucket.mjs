// Creates the S3 bucket from .env if it doesn't exist yet. Idempotent.
// Used by scripts/start-windows.ps1 (SeaweedFS has no compose init container).
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

const bucket = process.env.S3_BUCKET;
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

for (let attempt = 1; ; attempt++) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`bucket "${bucket}" ready`);
    break;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`bucket "${bucket}" created`);
      break;
    }
    if (attempt >= 20) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
