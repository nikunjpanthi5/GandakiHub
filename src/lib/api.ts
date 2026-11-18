import type { UserRole } from '../types/index.ts';

const TOKEN_STORAGE_KEY = 'gh_session_token';
let memoryToken: string | null = null;

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setSessionToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // fallback to in-memory token if storage is blocked
  }
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown> | null;
  constructor(message: string, status: number, data: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const token = getSessionToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
    const message = obj && 'error' in obj ? String(obj.error) : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, obj);
  }
  return data as T;
}

export const API_BASE_URL = (import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '');

export function resolveApiUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path) || path.startsWith('blob:') || path.startsWith('data:')) {
    return path;
  }
  if (!API_BASE_URL) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(resolveApiUrl(url), init);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(
        'Unable to reach the GandakiHub API server. If the free-tier backend was sleeping, it may take 30–50 seconds to wake up — please retry.',
        0,
        null
      );
    }
    throw err;
  }
}

export const api = {
  async get<T>(url: string): Promise<T> {
    const res = await apiFetch(url, {
      credentials: 'include',
      headers: buildHeaders(),
    });
    return handleResponse<T>(res);
  },
  async post<T>(url: string, body?: unknown): Promise<T> {
    const res = await apiFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(res);
  },
  async patch<T>(url: string, body?: unknown): Promise<T> {
    const res = await apiFetch(url, {
      method: 'PATCH',
      credentials: 'include',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(res);
  },
  async put<T>(url: string, body?: unknown): Promise<T> {
    const res = await apiFetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(res);
  },
  async delete<T>(url: string): Promise<T> {
    const res = await apiFetch(url, {
      method: 'DELETE',
      credentials: 'include',
      headers: buildHeaders(),
    });
    return handleResponse<T>(res);
  },
  async upload<T>(url: string, formData: FormData, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
    const res = await apiFetch(url, {
      method,
      credentials: 'include',
      headers: buildHeaders(),
      body: formData,
    });
    return handleResponse<T>(res);
  },
  async fetchBlob(url: string): Promise<Blob> {
    const res = await apiFetch(url, {
      credentials: 'include',
      headers: buildHeaders(),
    });
    if (!res.ok) {
      throw new ApiError(`Unable to load file (${res.status})`, res.status, null);
    }
    return res.blob();
  },
};

export function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRoleLabel(role: UserRole): string {
  const map: Record<UserRole, string> = {
    super_admin: 'Super Admin',
    admin: 'Admin',
    community_moderator: 'Moderator',
    verified_student: 'Verified Student',
    verified_teacher: 'Verified Teacher',
    future_student: 'Future Student',
    alumni: 'Alumni',
    visitor: 'Visitor',
  };
  return map[role] || role;
}
