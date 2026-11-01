// lib/googleDrive.js
// Read-only access to Google Drive / Google Docs with a service account.
// No extra dependencies: the OAuth JWT is signed with Node's crypto.
//
// Configure GOOGLE_SERVICE_ACCOUNT_JSON (the key file contents, raw JSON or
// base64) and share the textbook folder with the service account's email as
// Viewer. Base URLs are overridable for tests.

import crypto from 'crypto';

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const DRIVE = process.env.GOOGLE_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const DOCS = process.env.GOOGLE_DOCS_API_BASE || 'https://docs.googleapis.com/v1';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly';

export function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw.trim()) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text);
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

let cached = { token: '', exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const sa = serviceAccount();
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key));
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google auth failed: ${j.error_description || j.error || r.status}`);
  cached = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return cached.token;
}

async function gget(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Google API ${r.status} for ${url.replace(/\?.*/, '')}: ${body.slice(0, 300)}`);
  }
  return r;
}

// Lists Google Docs under a folder, recursing into subfolders. Subfolder names
// are returned as `path` so nested folders can become groups.
export async function listDocs(folderId, path = []) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const j = await (await gget(`${DRIVE}/files?${params}`)).json();
    for (const f of j.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') out.push(...await listDocs(f.id, [...path, f.name]));
      else if (f.mimeType === 'application/vnd.google-apps.document') out.push({ ...f, path });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function getDocument(docId) {
  return (await gget(`${DOCS}/documents/${encodeURIComponent(docId)}?includeTabsContent=true`)).json();
}

export async function downloadImage(url) {
  const r = await gget(url);
  const type = r.headers.get('content-type') || 'image/png';
  return { type, data: Buffer.from(await r.arrayBuffer()) };
}
