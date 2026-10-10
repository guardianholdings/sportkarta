import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Hiding a partner withdraws them everywhere at once (CLAUDE.md, Stage 8) —
 * including from the city and weekly pages, which are cached for an hour. The
 * partner and ad-placement actions, run for real with only the framework, the
 * session and the database mocked: each one that changes what
 * `PARTNER_RENDERABLE` or `activeAd` would answer must revalidate every public
 * partner surface.
 */
const h = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(readonly target: unknown) {
      super('NEXT_REDIRECT');
    }
  }
  return {
    Redirected,
    revalidatePath: vi.fn<(path: string, type?: string) => void>(),
    setPartnerVisible: vi.fn<(db: unknown, slug: string, visible: boolean) => Promise<void>>(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
// The actions redirect through next-intl, with the request's locale (A-14).
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('en') }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target);
  },
}));
vi.mock('@sportkarta/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/auth-session', () => ({ requireRole: () => Promise.resolve({ role: 'admin' }) }));
vi.mock('@/lib/contributions/photo-upload', () => ({
  storeContributionPhoto: () => Promise.resolve('ads/creative.webp'),
  discardContributionPhoto: () => Promise.resolve(),
}));
vi.mock('@/lib/partners', () => ({
  PartnerInputError: class PartnerInputError extends Error {},
  buildPartnerInput: () => ({ slug: 'acme' }),
  createPartner: () => Promise.resolve(),
  partnerBySlug: () => Promise.resolve({ slug: 'acme', logoPath: null }),
  setPartnerLogo: () => Promise.resolve(),
  setPartnerVisible: h.setPartnerVisible,
  updatePartner: () => Promise.resolve(true),
}));
vi.mock('@/lib/ads', () => ({
  AdPlacementError: class AdPlacementError extends Error {},
  buildAdPlacementInput: () => ({ slot: 'city_page' }),
  createPlacement: () => Promise.resolve(),
  deletePlacement: () => Promise.resolve('ads/creative.webp'),
  setPlacementVisible: () => Promise.resolve(),
}));

const { PARTNER_SURFACES } = await import('@/lib/partner-surfaces');
const { createPartnerAction, setVisibleAction, updatePartnerAction } =
  await import('@/app/[locale]/admin/(protected)/partnyori/actions');
const { createPlacementAction, deletePlacementAction, setPlacementVisibleAction } =
  await import('@/app/[locale]/admin/(protected)/partnyori/ad-actions');

afterEach(() => {
  vi.clearAllMocks();
});

function expectEverySurfaceRevalidated(): void {
  for (const surface of PARTNER_SURFACES) {
    expect(h.revalidatePath).toHaveBeenCalledWith(surface, 'page');
  }
}

describe('partner actions revalidate the cached public pages', () => {
  it('covers the cached city and weekly pages', () => {
    expect(PARTNER_SURFACES).toEqual(
      expect.arrayContaining(['/[locale]/igrishta/[city]', '/[locale]/sedmitsata/[city]']),
    );
  });

  it('withdraws a hidden partner from every surface at once', async () => {
    await setVisibleAction('acme', false);
    expect(h.setPartnerVisible).toHaveBeenCalledWith({}, 'acme', false);
    expectEverySurfaceRevalidated();
  });

  it('shows a partner made visible again without waiting for the hour', async () => {
    await setVisibleAction('acme', true);
    expectEverySurfaceRevalidated();
  });

  it('applies an edited window or tier everywhere', async () => {
    const state = await updatePartnerAction('acme', { error: null }, new FormData());
    expect(state).toEqual({ error: null, saved: true });
    expectEverySurfaceRevalidated();
  });

  it('puts a new headline partner on the strip before redirecting', async () => {
    await expect(createPartnerAction({ error: null }, new FormData())).rejects.toBeInstanceOf(
      h.Redirected,
    );
    expectEverySurfaceRevalidated();
  });

  it('redirects to the new partner in the locale the admin is working in', async () => {
    await expect(createPartnerAction({ error: null }, new FormData())).rejects.toMatchObject({
      target: { href: '/admin/partnyori/acme', locale: 'en' },
    });
  });

  it('revalidates nothing when the write was refused', async () => {
    await setVisibleAction('Not A Slug', false);
    expect(h.setPartnerVisible).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('ad-placement actions revalidate the same surfaces', () => {
  it('on create, publish and delete', async () => {
    const form = new FormData();
    form.set('creative', new File(['x'], 'creative.webp', { type: 'image/webp' }));
    await expect(createPlacementAction('acme', { error: null }, form)).resolves.toEqual({
      error: null,
      saved: true,
    });
    expectEverySurfaceRevalidated();

    vi.clearAllMocks();
    await setPlacementVisibleAction('acme', 7, false);
    expectEverySurfaceRevalidated();

    vi.clearAllMocks();
    await deletePlacementAction('acme', 7);
    expectEverySurfaceRevalidated();
  });
});
