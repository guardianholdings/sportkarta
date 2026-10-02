import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createPositionController,
  mountDecision,
  POSITION_OPTIONS,
  type PermissionWatch,
  type PositionEnvironment,
  type PositionPhase,
} from '../components/facility/position-controller';
import { showsRequestButton } from '../components/facility/position-fields';

/**
 * WHEN the browser is asked for a location (pre-launch audit, 2026-09).
 *
 * The contribution forms used to call getCurrentPosition from a mount effect.
 * The anonymous report form mounts on every facility page, so every visitor
 * arriving from search got a location prompt before touching anything — and a
 * reflexive Block is remembered for the whole origin, after which no form could
 * ever get a fix. These tests pin the replacement rule: mounting never puts the
 * question; a tap does. They also pin the 'use my location' button staying on
 * screen while a request is unanswered, which is the state Safari was seen to
 * leave a member in with nothing to tap.
 */

type Query = NonNullable<PositionEnvironment['permissions']>['query'];

function harness(
  options: {
    permission?: PermissionState | 'throws' | 'absent' | Promise<PermissionState>;
    secure?: boolean;
    geolocation?: boolean;
  } = {},
) {
  const calls: {
    success: PositionCallback;
    error: PositionErrorCallback | null | undefined;
    options: PositionOptions | undefined;
  }[] = [];
  const getCurrentPosition = vi.fn(
    (success: PositionCallback, error?: PositionErrorCallback | null, opts?: PositionOptions) => {
      calls.push({ success, error, options: opts });
    },
  );
  // A PermissionStatus stand-in: its state can be changed from outside, the
  // way the browser changes it when another form's prompt is answered.
  const listeners = new Set<() => void>();
  const status = {
    state: 'prompt' as PermissionState,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const query = vi.fn<Query>(async () => {
    const permission = await (options.permission ?? 'prompt');
    if (permission === 'throws') throw new TypeError("'geolocation' is not a valid name");
    if (permission === 'absent') throw new Error('unreachable: there is no Permissions API');
    status.state = permission;
    return status as unknown as PermissionWatch;
  });
  function changePermission(state: PermissionState) {
    status.state = state;
    for (const listener of listeners) listener();
  }
  const env: PositionEnvironment = {
    geolocation: options.geolocation === false ? undefined : { getCurrentPosition },
    isSecureContext: options.secure ?? true,
    permissions: options.permission === 'absent' ? undefined : { query },
  };
  const phases: PositionPhase[] = [];
  const fixes: [number, number][] = [];
  const controller = createPositionController(env, {
    setPhase: (phase) => phases.push(phase),
    writeFix: (latitude, longitude) => fixes.push([latitude, longitude]),
  });
  return {
    controller,
    getCurrentPosition,
    query,
    calls,
    phases,
    fixes,
    changePermission,
    listeners,
  };
}

function position(latitude: number, longitude: number): GeolocationPosition {
  return { coords: { latitude, longitude } } as GeolocationPosition;
}

function positionError(code: 1 | 2 | 3): GeolocationPositionError {
  return {
    code,
    message: '',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('mounting never puts the question', () => {
  it.each([
    { permission: 'prompt', why: 'the member has not decided' },
    { permission: 'absent', why: 'there is no Permissions API (older Safari)' },
    { permission: 'throws', why: "the API rejects the 'geolocation' name (Safari before 16)" },
  ] as const)(
    'does not call getCurrentPosition when the permission is $permission ($why)',
    async ({ permission }) => {
      const h = harness({ permission });
      await h.controller.start({ askOnMount: false });
      expect(h.getCurrentPosition).not.toHaveBeenCalled();
      expect(h.phases).toEqual([]);
    },
  );

  it('fetches silently when the member already allowed it — no prompt is possible', async () => {
    const h = harness({ permission: 'granted' });
    await h.controller.start({ askOnMount: false });
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('says up front that the site is blocked, without asking', async () => {
    const h = harness({ permission: 'denied' });
    await h.controller.start({ askOnMount: false });
    expect(h.getCurrentPosition).not.toHaveBeenCalled();
    expect(h.phases).toEqual(['denied']);
  });

  it('does not overwrite a tap already in flight with the blocked verdict', async () => {
    let answer: (state: PermissionState) => void = () => undefined;
    const h = harness({ permission: new Promise((resolve) => (answer = resolve)) });
    const started = h.controller.start({ askOnMount: false });
    h.controller.request();
    answer('denied');
    await started;
    expect(h.phases).toEqual(['asking']);
  });

  it('asks on mount only for a component that a tap mounted (askOnMount)', async () => {
    const h = harness({ permission: 'prompt' });
    const started = h.controller.start({ askOnMount: true });
    // Synchronously, before the permission read resolves: the tap is the
    // licence, and every tick spent first is a tick nearer to the browser
    // no longer counting the call as that tap's.
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
    await started;
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('names an insecure origin or a missing API at once, and never calls', async () => {
    const insecure = harness({ secure: false });
    await insecure.controller.start({ askOnMount: true });
    insecure.controller.request();
    expect(insecure.getCurrentPosition).not.toHaveBeenCalled();
    expect(insecure.phases).toEqual(['insecure', 'insecure']);

    const unsupported = harness({ geolocation: false });
    await unsupported.controller.start({ askOnMount: false });
    expect(unsupported.phases).toEqual(['unsupported']);
  });
});

describe('a tap puts the question', () => {
  it('writes the fix into the form and reports granted', () => {
    const h = harness();
    h.controller.request();
    expect(h.phases).toEqual(['asking']);
    expect(h.calls[0]?.options).toEqual(POSITION_OPTIONS);
    h.calls[0]?.success(position(42.69, 23.32));
    expect(h.fixes).toEqual([[42.69, 23.32]]);
    expect(h.phases).toEqual(['asking', 'granted']);
  });

  it('does not ask again once a fix is in hand', () => {
    const h = harness();
    h.controller.request();
    h.calls[0]?.success(position(42.69, 23.32));
    h.controller.request();
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('tells a block apart from a timeout or no signal', () => {
    const denied = harness();
    denied.controller.request();
    denied.calls[0]?.error?.(positionError(1));
    expect(denied.phases.at(-1)).toBe('denied');

    for (const code of [2, 3] as const) {
      const h = harness();
      h.controller.request();
      h.calls[0]?.error?.(positionError(code));
      expect(h.phases.at(-1)).toBe('unavailable');
    }
  });
});

describe('overlapping taps', () => {
  it('ignores a failure from an older request while a newer one is pending', () => {
    const h = harness();
    h.controller.request();
    h.controller.request();
    h.calls[0]?.error?.(positionError(3));
    expect(h.phases.at(-1)).toBe('asking');
    h.calls[1]?.success(position(42.1, 25.1));
    expect(h.phases.at(-1)).toBe('granted');
  });

  it('lets any success win, and no later failure undo it', () => {
    const h = harness();
    h.controller.request();
    h.controller.request();
    h.calls[0]?.success(position(42.1, 25.1));
    h.calls[1]?.error?.(positionError(1));
    expect(h.phases.at(-1)).toBe('granted');
    expect(h.fixes).toHaveLength(1);
  });
});

describe('an answer given elsewhere on the page', () => {
  // The verify and condition forms share a facility page, and /dobavi has the
  // pin picker's own locate button: one answer has to reach every form.
  it('fetches once the member allows location from another button', async () => {
    const h = harness({ permission: 'prompt' });
    await h.controller.start({ askOnMount: false });
    expect(h.getCurrentPosition).not.toHaveBeenCalled();
    h.changePermission('granted');
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
    h.calls[0]?.success(position(42.69, 23.32));
    expect(h.phases).toEqual(['asking', 'granted']);
  });

  it('does not double a request of its own that is still waiting on the prompt', async () => {
    const h = harness({ permission: 'prompt' });
    await h.controller.start({ askOnMount: false });
    h.controller.request();
    h.changePermission('granted');
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('says so when the site is blocked, and stops saying it once unblocked', async () => {
    const h = harness({ permission: 'prompt' });
    await h.controller.start({ askOnMount: false });
    h.changePermission('denied');
    expect(h.phases).toEqual(['denied']);
    h.changePermission('prompt');
    expect(h.phases).toEqual(['denied', 'idle']);
    expect(h.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('ignores the permission once it has a fix', async () => {
    const h = harness({ permission: 'granted' });
    await h.controller.start({ askOnMount: false });
    h.calls[0]?.success(position(42.69, 23.32));
    h.changePermission('denied');
    h.changePermission('granted');
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(h.phases.at(-1)).toBe('granted');
  });
});

describe('after unmount', () => {
  it('neither writes a late fix nor asks again', () => {
    const h = harness();
    h.controller.request();
    h.controller.dispose();
    h.calls[0]?.success(position(42.1, 25.1));
    h.controller.request();
    expect(h.fixes).toEqual([]);
    expect(h.phases).toEqual(['asking']);
    expect(h.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('stops listening to the permission', async () => {
    const h = harness({ permission: 'prompt' });
    await h.controller.start({ askOnMount: false });
    expect(h.listeners.size).toBe(1);
    h.controller.dispose();
    expect(h.listeners.size).toBe(0);
  });

  it('never starts listening when it unmounted during the permission read', async () => {
    const h = harness({ permission: 'prompt' });
    const started = h.controller.start({ askOnMount: false });
    h.controller.dispose();
    await started;
    expect(h.listeners.size).toBe(0);
  });
});

describe('mountDecision', () => {
  it('fetches only on an existing grant', () => {
    expect(mountDecision('granted')).toBe('fetch');
    expect(mountDecision('denied')).toBe('denied');
    expect(mountDecision('prompt')).toBe('wait');
    expect(mountDecision(null)).toBe('wait');
  });
});

describe('the «use my location» button', () => {
  it('stays on screen in every state until a fix is granted', () => {
    // 'asking' is the one that matters: a dropped request leaves the member
    // in it, and this button is then the only way to ask again.
    for (const phase of ['idle', 'asking', 'denied', 'unavailable'] as const) {
      expect(showsRequestButton(phase), phase).toBe(true);
    }
  });

  it('is withheld only where it could only fail, and once it has done its job', () => {
    for (const phase of ['granted', 'unsupported', 'insecure'] as const) {
      expect(showsRequestButton(phase), phase).toBe(false);
    }
  });
});

describe('no contribution form asks on its own', () => {
  const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  const sources = ['app', 'components']
    .flatMap((dir) => walk(path.join(WEB_ROOT, dir)))
    .map((file) => ({ file: path.relative(WEB_ROOT, file), source: readFileSync(file, 'utf8') }));

  it('only the report form body — mounted by its own open tap — asks on mount', () => {
    const askers = sources
      .filter(({ source }) => /usePosition\(\{\s*askOnMount:\s*true/.test(source))
      .map(({ file }) => file);
    expect(askers).toEqual([path.join('components', 'facility', 'report-form.tsx')]);
  });

  it('the collapsed report button mounts no position hook', () => {
    const source = sources.find(({ file }) => file.endsWith('report-form.tsx'))?.source ?? '';
    const collapsed = source.slice(
      source.indexOf('export function ReportForm('),
      source.indexOf('function ReportFormBody('),
    );
    expect(collapsed).toContain('if (!open)');
    expect(collapsed).not.toContain('usePosition');
  });

  it('the forms reach geolocation only through usePosition', () => {
    const forms = sources.filter(({ source }) => /PositionNotice|usePosition\(/.test(source));
    expect(forms.length).toBeGreaterThanOrEqual(5);
    for (const { file, source } of forms) {
      if (file.endsWith('position-fields.tsx')) continue;
      expect(source, file).not.toMatch(/getCurrentPosition|watchPosition/);
    }
  });
});
