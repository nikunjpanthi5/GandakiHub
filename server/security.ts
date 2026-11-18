import crypto from 'node:crypto';
import type { UserRole } from '../src/types/index.ts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

export function isUuid(value: string | undefined | null): value is string {
  return Boolean(value && UUID_REGEX.test(value.trim()));
}

export function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === 'production') {
    if (!configured || configured.length < 32 || configured.includes('change-me')) {
      throw new Error('SESSION_SECRET must be set to a strong random string (at least 32 characters) in production.');
    }
    return configured;
  }
  return configured || EPHEMERAL_DEV_SECRET;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashToken(raw: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(raw).digest('hex');
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function isUniversityEmail(email: string): boolean {
  return /^[^\s@]+@gandakiuniversity\.edu\.np$/i.test(email.trim());
}

export function sanitizeFilename(name: string): string {
  const base = name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '');
  return base.slice(0, 120) || 'document.pdf';
}

/**
 * Validates that a buffer is genuinely a PDF document:
 * 1. Rejects ZIP/Office archives (PK), executables (MZ), and image headers
 * 2. Begins with %PDF-1.x or %PDF-2.x magic bytes
 * 3. Contains obj/endobj PDF object markers
 * 4. Contains %%EOF near the end
 */
export function validatePdfBuffer(buffer: Buffer): { valid: boolean; reason?: string } {
  if (!buffer || buffer.length < 32) {
    return { valid: false, reason: 'File is too small to be a valid PDF document.' };
  }

  const headHex = buffer.subarray(0, 8).toString('hex').toLowerCase();
  if (headHex.startsWith('504b0304')) {
    return { valid: false, reason: 'ZIP or Office archive detected (e.g. DOCX/PPTX). Only genuine PDF files are allowed.' };
  }
  if (headHex.startsWith('4d5a')) {
    return { valid: false, reason: 'Executable files are strictly prohibited.' };
  }
  if (headHex.startsWith('89504e47') || headHex.startsWith('ffd8ff') || headHex.startsWith('47494638')) {
    return { valid: false, reason: 'Image files are not allowed in PDF-only academic categories.' };
  }
  if (headHex.startsWith('52617221')) {
    return { valid: false, reason: 'RAR archives are not allowed. Upload a genuine PDF file.' };
  }

  const header = buffer.subarray(0, 16).toString('ascii');
  if (!/^%PDF-\d\.\d/.test(header)) {
    return { valid: false, reason: 'Missing %PDF- header signature. File must be a genuine PDF.' };
  }

  const fullAscii = buffer.toString('latin1');
  if (!fullAscii.includes('obj') || !fullAscii.includes('endobj')) {
    return { valid: false, reason: 'Invalid PDF internal structure (missing PDF objects).' };
  }

  const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    return { valid: false, reason: 'Truncated or malformed PDF (missing %%EOF marker).' };
  }

  return { valid: true };
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isAdminRole(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin';
}

export function isModeratorOrAbove(role: UserRole): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'community_moderator';
}

export function canUploadResources(role: UserRole): boolean {
  return (
    role === 'super_admin' ||
    role === 'admin' ||
    role === 'community_moderator' ||
    role === 'verified_student' ||
    role === 'verified_teacher'
  );
}

export function canPostInCommunity(
  role: UserRole,
  communityKind: 'academic' | 'special',
  communitySlug: string
): { allowed: boolean; reason?: string } {
  if (role === 'visitor') {
    return { allowed: false, reason: 'Visitors have read-only access on GandakiHub.' };
  }
  if (role === 'future_student') {
    if (communitySlug === 'future-students') {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'Future Student accounts can participate in the Future Students community only.',
    };
  }
  if (communityKind === 'academic' && role === 'alumni') {
    return {
      allowed: false,
      reason: 'Alumni cannot post in current-semester academic communities.',
    };
  }
  return { allowed: true };
}

export function canVoteOrComment(
  role: UserRole,
  communityKind: 'academic' | 'special',
  communitySlug: string
): boolean {
  if (role === 'visitor') return false;
  if (role === 'future_student') {
    return communitySlug === 'future-students';
  }
  if (communityKind === 'academic' && role === 'alumni') {
    return false;
  }
  return true;
}
