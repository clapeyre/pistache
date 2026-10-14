import { readFileSync, lstatSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PROFILE_FILES = ['SYSTEM.md', 'SOUL.md', 'USER.md', 'MEMORY.md', 'profile.json'];
const revision = text => createHash('sha256').update(text).digest('hex');
function error(status, message) { return Object.assign(new Error(message), { status }); }
function filePath(dir, name) {
  if (!PROFILE_FILES.includes(name)) throw error(400, 'Unknown profile file');
  let root;
  try { root = realpathSync(dir); } catch { throw error(503, 'Profile directory unavailable'); }
  const path = join(root, name);
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw error(403, 'Linked profile files are not supported'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return path;
}
function read(dir, name) {
  const path = filePath(dir, name);
  try { const text = readFileSync(path, 'utf8'); if (text.length > 8000) throw error(413, 'Profile file is too large'); return text; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function containsSecret(text, secrets) {
  return secrets.some(value => value && text.includes(value)) || /(?:sk-or-v1-|sk-|github_pat_|ghp_)[A-Za-z0-9_-]{12,}/u.test(text);
}
export function listProfiles(dir, editable, secrets = []) {
  return { editable, files: PROFILE_FILES.map(name => {
    const content = read(dir, name);
    const hidden = content !== null && containsSecret(content, secrets);
    return { name, exists: content !== null, content: hidden ? null : content, revision: content === null ? null : revision(content), editable: editable && !hidden, hidden };
  }) };
}
export function saveProfile(dir, name, body, editable, secrets = []) {
  if (!editable) throw error(403, 'Profile editing is disabled');
  const path = filePath(dir, name);
  if (!body || typeof body.content !== 'string' || body.content.length > 8000 || body.content.includes('\0')) throw error(400, 'Invalid profile content');
  if (containsSecret(body.content, secrets)) throw error(400, 'Keep credentials out of profile files');
  const previous = read(dir, name);
  if (previous !== null && containsSecret(previous, secrets)) throw error(403, 'This file contains credentials');
  if (body.revision !== (previous === null ? null : revision(previous))) throw error(409, 'Profile changed since it was opened');
  if (name === 'profile.json') { try { JSON.parse(body.content); } catch { throw error(400, 'Invalid profile JSON'); } }
  const size = PROFILE_FILES.reduce((sum, file) => { const text = file === name ? body.content : read(dir, file); return sum + (text === null ? 0 : text.length + file.length + 5); }, 0);
  if (size > 23900) throw error(413, 'Combined profile is too large');
  const temp = join(realpathSync(dir), `.profile-${randomUUID()}.tmp`);
  try { writeFileSync(temp, body.content, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch {} }
  return listProfiles(dir, editable, secrets);
}
