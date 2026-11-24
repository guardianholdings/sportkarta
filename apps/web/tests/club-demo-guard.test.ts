import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { demoBlocksSubmit } from '@/lib/clubs/demo-guard';

const web = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(web, rel), 'utf8');

describe('demo club: the form guard', () => {
  it('lets a GET form to a real address through (list filters only navigate)', () => {
    expect(demoBlocksSubmit({ method: null, action: null })).toBe(false);
    expect(demoBlocksSubmit({ method: 'get', action: '/bg/klub/demo/chlenove' })).toBe(false);
    expect(demoBlocksSubmit({ method: 'GET', action: '' })).toBe(false);
    expect(demoBlocksSubmit({ method: 'dialog', action: null })).toBe(false);
  });

  it('stops anything that would save or send', () => {
    expect(demoBlocksSubmit({ method: 'post', action: '' })).toBe(true);
    expect(demoBlocksSubmit({ method: 'POST', action: '/bg/klub/demo/chlenove' })).toBe(true);
    expect(demoBlocksSubmit({ method: 'put', action: null })).toBe(true);
    const reactAction = "javascript:throw new Error('A React form was unexpectedly submitted.')";
    expect(demoBlocksSubmit({ method: null, action: reactAction })).toBe(true);
  });

  it('wraps the office pages in the guard only for the demo, with its line', () => {
    const shell = read('components/clubs/club-shell.tsx');
    expect(shell).toContain("state === 'demo' ? (");
    expect(shell).toContain("<DemoFormGuard message={t('demoBlocked')}>");
  });

  it('stops the submit in the capture phase, before React sees it', () => {
    const guard = read('components/clubs/demo-form-guard.tsx');
    expect(guard).toContain("addEventListener('submit', onSubmit, true)");
    expect(guard).toContain('event.preventDefault()');
    expect(guard).toContain('event.stopPropagation()');
  });

  it('has the line in both locales', () => {
    for (const locale of ['bg', 'en']) {
      const messages = JSON.parse(read(`messages/${locale}.json`)) as {
        ClubOffice: { demoBlocked?: string };
      };
      expect(messages.ClubOffice.demoBlocked?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
