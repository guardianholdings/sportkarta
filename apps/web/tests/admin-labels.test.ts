import { describe, expect, it } from 'vitest';

import { labelTranslator } from '@/components/admin/use-labels';
import bg from '../messages/bg.json';

/**
 * The admin wizards' label bags are ICU templates formatted on the client
 * (components/admin/use-labels.ts): a `.replace('{count}', …)` printed
 * «1 тренировки».
 */
describe('labelTranslator', () => {
  const labels = {
    created: '{count, plural, one {Създадена е # тренировка.} other {Създадени са # тренировки.}}',
    truncated: 'Само първите {shown} от {total}.',
  };

  it('chooses the plural form by the count', () => {
    const t = labelTranslator('bg', labels);
    expect(t('created', { count: 1 })).toBe('Създадена е 1 тренировка.');
    expect(t('created', { count: 5 })).toBe('Създадени са 5 тренировки.');
  });

  it('fills plain arguments too', () => {
    expect(labelTranslator('bg', labels)('truncated', { shown: 2000, total: 2400 })).toBe(
      'Само първите 2000 от 2400.',
    );
  });

  it('renders an unknown key as itself, never blank', () => {
    expect(labelTranslator('bg', labels)('error_no_such_code')).toBe('error_no_such_code');
  });

  it('formats every count message the bulk-create screen ships', () => {
    const t = labelTranslator('bg', bg.AdminBulkSessions);
    for (const key of ['selectedCount', 'createConfirm', 'createConfirmOnce', 'createdCount']) {
      expect(t(key, { count: 1 }), key).not.toBe(t(key, { count: 2 }));
      expect(t(key, { count: 1 }), key).not.toMatch(/[{}]/);
    }
  });

  it('formats the results screen too, and names every grid cell', () => {
    const t = labelTranslator('bg', bg.AdminResults);
    expect(t('saved', { count: 1 })).toBe('Запазен е 1 резултат.');
    expect(t('saved', { count: 3 })).toBe('Запазени са 3 резултата.');
    expect(t('cellLabel', { field: t('team'), row: 2 })).toBe('Отбор, ред 2');
  });
});
