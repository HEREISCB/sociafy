// One-off: let browsers PUT raw clips straight to R2 with a presigned URL ("Edit my video",
// /api/media/upload-url). Without this rule the browser's preflight fails and uploads error out.
//   node --env-file=.env scripts/r2-cors.mjs            # show the current rule
//   node --env-file=.env scripts/r2-cors.mjs --apply    # set it
// The URL is still signed per object and per content type; CORS only lets the browser send it.
import { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';

const e = process.env;
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
});
const Bucket = e.R2_BUCKET_NAME;
const rule = {
  AllowedOrigins: ['https://sociafy.app', 'https://www.sociafy.app', 'http://localhost:3000'],
  AllowedMethods: ['PUT'],
  AllowedHeaders: ['content-type'],
  MaxAgeSeconds: 3600,
};

if (process.argv.includes('--apply')) await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [rule] } }));
try {
  console.log(JSON.stringify((await s3.send(new GetBucketCorsCommand({ Bucket }))).CORSRules, null, 1));
} catch (x) {
  console.log(x.name === 'NoSuchCORSConfiguration' ? 'No CORS rule yet: run with --apply.' : `${x.name}: ${x.message}`);
}
