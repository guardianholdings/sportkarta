import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';
import { moderationDecision, moderationTarget } from '@sportkarta/db/schema';

/**
 * The account screens print people and vocabularies legibly (UX audit
 * 2026-10-10, A-11 and A-14).
 */
const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin', '(protected)', 'akaunti');
const list = readFileSync(path.join(ADMIN, 'page.tsx'), 'utf8');
const detail = readFileSync(path.join(ADMIN, '[id]', 'page.tsx'), 'utf8');

describe('/admin/akaunti', () => {
  it('sets a member row in body text, not the 12px uppercase overline', () => {
    expect(list).toMatch(/<th scope="row" className="py-2 pr-3 text-left font-normal">/);
    expect(list).not.toMatch(/<th scope="row" className="t-overline/);
  });
});

describe('/admin/akaunti/[id]', () => {
  it('translates the stored vocabularies instead of printing slugs', () => {
    for (const raw of [
      /^\s*row\.event,$/m,
      /^\s*row\.field,$/m,
      /^\s*row\.source,$/m,
      /^\s*row\.targetType,$/m,
      /^\s*row\.decision,$/m,
      /`\$\{row\.method\}: /,
    ]) {
      expect(detail).not.toMatch(raw);
    }
  });

  it('labels every decision and target the log can hold, in both languages', () => {
    for (const messages of [bg.AdminAccounts, en.AdminAccounts]) {
      for (const decision of moderationDecision.enumValues) {
        expect(messages.decision[decision], decision).toBeTruthy();
      }
      for (const target of moderationTarget.enumValues) {
        expect(messages.targetType[target], target).toBeTruthy();
      }
    }
  });
});
