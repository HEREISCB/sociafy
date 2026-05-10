import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, isStubMode } from '../env';

let _client: S3Client | null = null;

export function getR2(): S3Client | null {
  if (isStubMode.r2()) return null;
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2.accessKeyId!,
      secretAccessKey: env.r2.secretAccessKey!,
    },
  });
  return _client;
}

export function publicUrlFor(key: string): string {
  const base = env.r2.publicBase || `https://${env.r2.bucket}.r2.dev`;
  return `${base.replace(/\/$/, '')}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
}

export async function presignPut(args: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<{ url: string; key: string }> {
  const client = getR2();
  if (!client) {
    return { url: '', key: args.key };
  }
  const cmd = new PutObjectCommand({
    Bucket: env.r2.bucket!,
    Key: args.key,
    ContentType: args.contentType,
  });
  const url = await getSignedUrl(client, cmd, { expiresIn: args.expiresInSeconds ?? 600 });
  return { url, key: args.key };
}

export async function uploadBuffer(args: {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}) {
  const client = getR2();
  if (!client) throw new Error('r2_not_configured');
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2.bucket!,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
  return { key: args.key, url: publicUrlFor(args.key) };
}

export async function deleteObject(key: string) {
  const client = getR2();
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: env.r2.bucket!, Key: key }));
}

export function makeMediaKey(userId: string, fileName: string): string {
  const safe = fileName.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 80);
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `users/${userId}/${stamp}-${rand}-${safe}`;
}
