'use client';

import {
  ArrowRight,
  Heart,
  Layers,
  List,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Plus,
  Rss,
  Search,
  SlidersHorizontal,
  Star,
  TrendingUp,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Avatar } from '@/components/ui/avatar';
import { Badge, type BadgeTone, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { MapMarker } from '@/components/ui/map-marker';
import { Radio } from '@/components/ui/radio';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Stat } from '@/components/ui/stat';
import { Switch } from '@/components/ui/switch';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import { CANONICAL_SPORTS, type CanonicalSport } from '@sportkarta/lib/sports';

// ── Small layout helpers (presentation only) ────────────────────────────────

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="mb-4 text-h3 font-bold tracking-tight text-ink">{title}</h2>
      <div className="rounded-card border border-line bg-surface p-5 shadow-sm">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-line py-4 last:border-0 last:pb-0 sm:flex-row sm:items-center">
      <span className="font-mono text-overline uppercase tracking-overline text-text-muted sm:w-40 sm:shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Swatch({ token, label }: { token: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="size-16 rounded-md border border-line shadow-xs"
        style={{ background: `var(${token})` }}
      />
      <code className="font-mono text-overline text-text-muted">{label ?? token}</code>
    </div>
  );
}

const RAMP = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

export default function DesignSystemPage() {
  const t = useTranslations('DesignSystem');
  const s = useTranslations('Sport');

  const [view, setView] = React.useState('map');
  const [period, setPeriod] = React.useState('month');
  const [filters, setFilters] = React.useState<Set<CanonicalSport>>(new Set(['hiking', 'swimming']));
  const [layers, setLayers] = React.useState(true);
  const [notify, setNotify] = React.useState(false);

  const toggleFilter = (sport: CanonicalSport) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(sport)) next.delete(sport);
      else next.add(sport);
      return next;
    });

  const tones: BadgeTone[] = ['neutral', 'brand', 'accent', 'success', 'warning', 'danger', 'info'];
  const badgeVariants: BadgeVariant[] = ['soft', 'solid', 'outline'];
  const filterSports: CanonicalSport[] = ['hiking', 'running', 'cycling', 'swimming', 'football', 'tennis'];

  return (
    <div className="mx-auto max-w-[70rem] px-6 py-10">
      <header className="mb-10">
        <p className="font-mono text-overline uppercase tracking-overline text-accent">
          {t('overline')}
        </p>
        <h1 className="mt-2 text-display-lg font-extrabold tracking-tighter text-ink">{t('title')}</h1>
        <p className="mt-3 max-w-2xl text-body-lg text-ink-soft">{t('subtitle')}</p>
        <p className="mt-2 text-body-sm text-text-muted">{t('internalNote')}</p>
      </header>

      <div className="flex flex-col gap-12">
        {/* ── Colour ─────────────────────────────────────────────── */}
        <Section id="color" title={t('sections.color')}>
          <Row label={t('groups.brand')}>
            {RAMP.map((step) => (
              <Swatch key={step} token={`--pine-${step}`} label={`pine-${step}`} />
            ))}
          </Row>
          <Row label={t('groups.accent')}>
            {['50', '100', '200', '300', '400', '500', '600', '700'].map((step) => (
              <Swatch key={step} token={`--clay-${step}`} label={`clay-${step}`} />
            ))}
          </Row>
          <Row label={t('groups.neutral')}>
            {['--paper', '--paper-sunk', '--surface', '--surface-2', '--border', '--border-strong'].map(
              (tk) => (
                <Swatch key={tk} token={tk} />
              ),
            )}
          </Row>
          <Row label={t('groups.text')}>
            {['--ink', '--ink-soft', '--text-muted', '--text-faint'].map((tk) => (
              <Swatch key={tk} token={tk} />
            ))}
          </Row>
          <Row label={t('groups.semantic')}>
            {['--success', '--warning', '--danger', '--info'].map((tk) => (
              <Swatch key={tk} token={tk} />
            ))}
          </Row>
        </Section>

        {/* ── Category colours ───────────────────────────────────── */}
        <Section id="categories" title={t('sections.categories')}>
          <p className="mb-4 text-body-sm text-ink-soft">{t('categoriesNote')}</p>
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            {(
              [
                ['--cat-hike', false],
                ['--cat-run', false],
                ['--cat-bike', false],
                ['--cat-climb', false],
                ['--cat-swim', false],
                ['--cat-team', false],
                ['--cat-calisthenics', false],
                ['--cat-racket', true],
                ['--cat-precision', true],
                ['--cat-multi', true],
              ] as const
            ).map(([tk, derived]) => (
              <div key={tk} className="flex items-center gap-2.5">
                <span
                  className="size-6 rounded-full shadow-xs"
                  style={{ background: `var(${tk})` }}
                />
                <div className="flex flex-col">
                  <code className="font-mono text-caption text-ink">{tk}</code>
                  {derived ? (
                    <span className="font-mono text-overline uppercase tracking-overline text-accent">
                      {t('labels.derived')}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Typography ─────────────────────────────────────────── */}
        <Section id="type" title={t('sections.type')}>
          <div className="flex flex-col gap-4">
            <p className="text-display-lg font-extrabold tracking-tighter text-ink">{t('type.display')}</p>
            <p className="text-h1 font-bold tracking-tight text-ink">{t('type.heading')}</p>
            <p className="text-body-lg text-ink">{t('type.body')}</p>
            <p className="text-body-sm text-ink-soft">{t('type.bodySmall')}</p>
            <p className="font-mono text-body-sm tabular-nums text-ink-soft">{t('type.dataSample')}</p>
            <p className="font-mono text-overline uppercase tracking-overline text-text-muted">
              {t('type.overline')}
            </p>
          </div>
        </Section>

        {/* ── Radius & elevation ─────────────────────────────────── */}
        <Section id="radius" title={t('sections.radiusElevation')}>
          <Row label={t('groups.radius')}>
            {(['--radius-md', '--radius-lg', '--radius-xl', '--radius-pill'] as const).map((tk) => (
              <div key={tk} className="flex flex-col gap-1.5">
                <div
                  className="size-16 border border-line-strong bg-surface-2"
                  style={{ borderRadius: `var(${tk})` }}
                />
                <code className="font-mono text-overline text-text-muted">{tk}</code>
              </div>
            ))}
          </Row>
          <Row label={t('groups.elevation')}>
            {(['--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-float'] as const).map(
              (tk) => (
                <div key={tk} className="flex flex-col gap-1.5">
                  <div className="size-16 rounded-md bg-surface" style={{ boxShadow: `var(${tk})` }} />
                  <code className="font-mono text-overline text-text-muted">{tk}</code>
                </div>
              ),
            )}
          </Row>
        </Section>

        {/* ── Button ─────────────────────────────────────────────── */}
        <Section id="button" title="Button">
          <Row label={t('states.variants')}>
            <Button variant="primary">{t('demo.addSpot')}</Button>
            <Button variant="accent">{t('demo.join')}</Button>
            <Button variant="secondary">{t('demo.cancel')}</Button>
            <Button variant="ghost">{t('demo.seeAll')}</Button>
            <Button variant="danger">{t('demo.delete')}</Button>
          </Row>
          <Row label={t('states.sizes')}>
            <Button size="sm">{t('demo.save')}</Button>
            <Button size="md">{t('demo.save')}</Button>
            <Button size="lg">{t('demo.save')}</Button>
          </Row>
          <Row label={t('states.icons')}>
            <Button iconLeft={<MapPin size={20} />}>{t('demo.addSpot')}</Button>
            <Button variant="accent" iconRight={<ArrowRight size={20} />}>
              {t('demo.join')}
            </Button>
          </Row>
          <Row label={t('states.disabled')}>
            <Button disabled>{t('demo.save')}</Button>
            <Button variant="accent" disabled>
              {t('demo.join')}
            </Button>
          </Row>
        </Section>

        {/* ── IconButton ─────────────────────────────────────────── */}
        <Section id="icon-button" title="IconButton">
          <Row label={t('states.variants')}>
            <IconButton aria-label={t('demo.filters')} variant="surface">
              <SlidersHorizontal size={20} />
            </IconButton>
            <IconButton aria-label={t('demo.save')} variant="solid">
              <Plus size={20} />
            </IconButton>
            <IconButton aria-label={t('demo.locate')} variant="floating">
              <LocateFixed size={20} />
            </IconButton>
            <IconButton aria-label={t('demo.like')} variant="ghost" round>
              <Heart size={20} />
            </IconButton>
          </Row>
          <Row label={t('states.sizes')}>
            <IconButton aria-label={t('demo.layers')} size="sm">
              <Layers size={18} />
            </IconButton>
            <IconButton aria-label={t('demo.layers')} size="md">
              <Layers size={20} />
            </IconButton>
            <IconButton aria-label={t('demo.layers')} size="lg">
              <Layers size={24} />
            </IconButton>
          </Row>
        </Section>

        {/* ── Input & Select ─────────────────────────────────────── */}
        <Section id="input" title="Input · Select">
          <Row label={t('states.default')}>
            <Input placeholder={t('demo.search')} iconLeft={<Search size={18} />} className="max-w-xs" />
          </Row>
          <Row label={t('states.sizes')}>
            <Input size="sm" placeholder="sm" className="max-w-40" />
            <Input size="md" placeholder="md" className="max-w-40" />
            <Input size="lg" placeholder="lg" className="max-w-40" />
          </Row>
          <Row label={t('states.invalid')}>
            <Input invalid defaultValue={t('demo.invalidValue')} className="max-w-xs" />
          </Row>
          <Row label="Select">
            <Select defaultValue="all" className="max-w-xs">
              <option value="all">{s('multi')}</option>
              <option value="hiking">{s('hiking')}</option>
              <option value="cycling">{s('cycling')}</option>
            </Select>
          </Row>
        </Section>

        {/* ── Checkbox · Radio · Switch ──────────────────────────── */}
        <Section id="controls" title="Checkbox · Radio · Switch">
          <Row label="Checkbox">
            <Checkbox label={t('demo.dogsAllowed')} defaultChecked />
            <Checkbox label={t('demo.parking')} />
            <Checkbox label={t('demo.disabled')} disabled />
          </Row>
          <Row label="Radio">
            <Radio name="ds-diff" label={t('demo.easy')} defaultChecked />
            <Radio name="ds-diff" label={t('demo.moderate')} />
            <Radio name="ds-diff" label={t('demo.hard')} />
          </Row>
          <Row label="Switch">
            <Switch label={t('demo.satellite')} checked={layers} onChange={(e) => setLayers(e.target.checked)} />
            <Switch label={t('demo.notifications')} checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <Switch label={t('demo.disabled')} disabled />
          </Row>
        </Section>

        {/* ── Card ───────────────────────────────────────────────── */}
        <Section id="card" title="Card">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card
              interactive
              padding="md"
              media={<div className="stripe-placeholder h-28" />}
              footer={
                <div className="flex items-center justify-between">
                  <Stat value={t('demo.distanceValueShort')} label={t('demo.distance')} />
                  <Badge tone="success">{t('demo.open')}</Badge>
                </div>
              }
            >
              <h3 className="text-h4 font-bold text-ink">{t('demo.spotName')}</h3>
              <p className="text-body-sm text-text-muted">{t('demo.spotArea')}</p>
            </Card>
            <Card padding="md">
              <h3 className="text-h4 font-bold text-ink">{t('demo.plainCard')}</h3>
              <p className="text-body-sm text-ink-soft">{t('demo.plainCardBody')}</p>
            </Card>
            <Card padding="lg">
              <div className="flex items-center gap-3">
                <Avatar name={t('demo.names.you')} ring />
                <div>
                  <p className="text-body-sm font-semibold text-ink">{t('demo.member')}</p>
                  <p className="font-mono text-caption tabular-nums text-text-muted">{t('demo.memberMeta')}</p>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ── Badge ──────────────────────────────────────────────── */}
        <Section id="badge" title="Badge">
          {badgeVariants.map((v) => (
            <Row key={v} label={v}>
              {tones.map((tone) => (
                <Badge key={tone} tone={tone} variant={v}>
                  {t(`demo.tones.${tone}`)}
                </Badge>
              ))}
            </Row>
          ))}
          <Row label={t('states.icons')}>
            <Badge tone="warning" icon={<Star size={13} />}>
              {t('demo.moderate')}
            </Badge>
            <Badge tone="accent" variant="solid">
              {t('demo.new')}
            </Badge>
          </Row>
        </Section>

        {/* ── Chip ───────────────────────────────────────────────── */}
        <Section id="chip" title="Chip">
          <p className="mb-4 text-body-sm text-ink-soft">{t('chipNote')}</p>
          <div className="flex flex-wrap gap-2">
            {filterSports.map((sport) => {
              const { color, Icon } = SPORT_VISUALS[sport];
              return (
                <Chip
                  key={sport}
                  color={color}
                  selected={filters.has(sport)}
                  onClick={() => toggleFilter(sport)}
                  icon={<Icon size={16} />}
                >
                  {s(sport)}
                </Chip>
              );
            })}
          </div>
        </Section>

        {/* ── Avatar ─────────────────────────────────────────────── */}
        <Section id="avatar" title="Avatar">
          <Row label={t('states.sizes')}>
            {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((sz) => (
              <Avatar key={sz} name={t('demo.names.ivana')} size={sz} />
            ))}
          </Row>
          <Row label={t('states.states')}>
            <Avatar name={t('demo.names.you')} ring />
            <Avatar name={t('demo.names.georgi')} status="online" />
            <Avatar name={t('demo.names.maria')} status="offline" />
          </Row>
          <Row label={t('demo.stack')}>
            <div className="flex -space-x-2">
              {(['a', 'b', 'c', 'd'] as const).map((k) => (
                <Avatar key={k} name={t(`demo.names.stack.${k}`)} ring />
              ))}
            </div>
          </Row>
        </Section>

        {/* ── Stat ───────────────────────────────────────────────── */}
        <Section id="stat" title="Stat">
          <Row label={t('states.default')}>
            <Stat value={t('demo.distanceValue')} label={t('demo.distance')} />
            <Stat value={t('demo.ascentValue')} label={t('demo.ascent')} tone="brand" icon={<TrendingUp size={18} />} />
            <Stat value={t('demo.rankValue')} label={t('demo.thisMonth')} tone="accent" align="center" />
          </Row>
        </Section>

        {/* ── SegmentedControl ───────────────────────────────────── */}
        <Section id="segmented" title="SegmentedControl">
          <Row label={t('states.default')}>
            <SegmentedControl
              value={view}
              onChange={setView}
              items={[
                { value: 'map', label: t('seg.map'), icon: <MapIcon size={18} /> },
                { value: 'list', label: t('seg.list'), icon: <List size={18} /> },
                { value: 'feed', label: t('seg.feed'), icon: <Rss size={18} /> },
              ]}
            />
          </Row>
          <Row label={t('states.fullWidth')}>
            <div className="w-full max-w-md">
              <SegmentedControl
                fullWidth
                value={period}
                onChange={setPeriod}
                items={[
                  { value: 'week', label: t('seg.week') },
                  { value: 'month', label: t('seg.month') },
                  { value: 'year', label: t('seg.year') },
                ]}
              />
            </div>
          </Row>
        </Section>

        {/* ── MapMarker ──────────────────────────────────────────── */}
        <Section id="map-marker" title="MapMarker">
          <Row label={t('states.variants')}>
            {filterSports.map((sport) => {
              const { color, Icon } = SPORT_VISUALS[sport];
              return <MapMarker key={sport} color={color} icon={<Icon size={18} />} />;
            })}
          </Row>
          <Row label={t('states.states')}>
            <MapMarker color="var(--cat-swim)" icon={<SPORT_VISUALS.swimming.Icon size={18} />} />
            <MapMarker active color="var(--cat-swim)" icon={<SPORT_VISUALS.swimming.Icon size={18} />} />
            <MapMarker variant="dot" color="var(--cat-run)" />
            <MapMarker variant="cluster" color="var(--brand)" count={12} />
          </Row>
        </Section>

        {/* ── Category re-map (GATE 1, realised) ─────────────────── */}
        <Section id="category-map" title={t('sections.categoryMap')}>
          <p className="mb-4 text-body-sm text-ink-soft">{t('categoryMapNote')}</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {CANONICAL_SPORTS.map((sport) => {
              const { color, Icon, family } = SPORT_VISUALS[sport];
              return (
                <div key={sport} className="flex items-center gap-2.5">
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-full text-on-brand shadow-xs"
                    style={{ background: color }}
                  >
                    <Icon size={16} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-body-sm text-ink">{s(sport)}</p>
                    <p className="font-mono text-overline uppercase tracking-overline text-text-muted">
                      {family}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}
