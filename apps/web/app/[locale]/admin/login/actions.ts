'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { ADMIN_COOKIE, verifyAdminToken } from '@/lib/admin-auth';

export interface LoginState {
  error: 'invalid' | 'throttled' | null;
}

// In-memory throttle: fine for the single-container deployment this
// temporary auth scheme lives in. TODO(stage-3): better-auth replaces all of this.
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function throttled(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const headerStore = await headers();
  const ip = headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  if (throttled(ip)) return { error: 'throttled' };

  const token = String(formData.get('token') ?? '');
  const identity = verifyAdminToken(token);
  if (!identity) return { error: 'invalid' };

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE);
  redirect('/admin/login');
}
