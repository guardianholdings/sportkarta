import { describe, expect, it } from 'vitest';

import {
  renderModerationMail,
  type ModerationMailData,
  type ModerationMailStrings,
} from './moderation-mail.js';

const STRINGS: ModerationMailStrings = {
  subjectPhotoRejected: 'Your photo was not published',
  subjectPhotoRemoved: 'Your photo was taken down',
  subjectFacilityRemoved: 'A facility you added was removed',
  subjectNoticeReceived: 'We received your notice',
  subjectNoticeDecided: 'Decision on your notice',
  greeting: 'Hello,',
  leadPhotoRejected: 'Your photo of {facility} was not published.',
  leadPhotoRemoved: 'Your photo of {facility} was taken down.',
  leadFacilityRemoved: '{facility}, which you added, was removed from the map.',
  leadNoticeReceived: 'We received your notice about {url} on {date}.',
  leadNoticeActioned: 'We acted on your notice about {url}.',
  leadNoticeDismissed: 'We took no action on your notice about {url}.',
  noticeNextSteps: 'A person will review it and write to you.',
  labelReason: 'Reason',
  labelDecidedOn: 'Decided on {date}',
  groundLaw: 'Ground: the content appeared to be illegal.',
  groundTerms: 'Ground: the terms of use.',
  humanDecision: 'A person decided this; nothing was automated.',
  contestEmail: 'To contest this, write to {email}.',
  contestForm: 'To contest this, use {url}.',
  courts: 'You may also go to court.',
  terms: 'Terms: {url}',
  unnamedFacility: 'an unnamed facility',
  footer: 'POPS',
};

const BASE: ModerationMailData = {
  kind: 'photo_rejected',
  facilityName: 'Борисова градина',
  facilityUrl: 'https://pops.bg/obekt/borisova-gradina',
  reasonLabel: 'An identifiable person is shown',
  ground: 'terms',
  date: '30.09.2026',
  termsUrl: 'https://pops.bg/usloviya',
  contactEmail: 'info@pops.bg',
  noticeFormUrl: 'https://pops.bg/signal',
};

function mail(overrides: Partial<ModerationMailData> = {}) {
  return renderModerationMail({ ...BASE, ...overrides }, STRINGS);
}

describe('renderModerationMail — statement of reasons', () => {
  it('says what was decided, why, on what ground, by whom and how to contest it', () => {
    const { subject, text } = mail();
    expect(subject).toBe('Your photo was not published');
    expect(text).toContain('Your photo of Борисова градина was not published.');
    expect(text).toContain('Reason: An identifiable person is shown');
    expect(text).toContain('Decided on 30.09.2026');
    expect(text).toContain('Ground: the terms of use.');
    expect(text).toContain('A person decided this; nothing was automated.');
    expect(text).toContain('To contest this, write to info@pops.bg.');
    expect(text).toContain('You may also go to court.');
    expect(text).toContain('Terms: https://pops.bg/usloviya');
  });

  it('tells a takedown apart from a refusal — the photo WAS public', () => {
    const { subject, text } = mail({ kind: 'photo_removed', ground: 'law' });
    expect(subject).toBe('Your photo was taken down');
    expect(text).toContain('Your photo of Борисова градина was taken down.');
    expect(text).toContain('Ground: the content appeared to be illegal.');
    expect(text).toContain('You may also go to court.');
  });

  it('states the legal ground when the reason claims illegality', () => {
    expect(mail({ ground: 'law' }).text).toContain('Ground: the content appeared to be illegal.');
  });

  it('falls back to the notice form while no contact address is published', () => {
    const { text } = mail({ contactEmail: null });
    expect(text).toContain('To contest this, use https://pops.bg/signal.');
    expect(text).not.toContain('write to');
  });

  it('names an unnamed facility honestly instead of printing an empty quote', () => {
    const { text } = mail({ kind: 'facility_removed', facilityName: '  ', facilityUrl: undefined });
    expect(text).toContain('an unnamed facility, which you added, was removed from the map.');
  });

  it('never mentions a notifier or the moderator — nothing to target', () => {
    const { text } = mail();
    expect(text).not.toMatch(/report|notif|moderator/i);
  });

  it('carries an HTML part rendered from the same text', () => {
    const { html } = mail();
    expect(html).toContain('Борисова градина');
    expect(html).toContain('<a href="https://pops.bg/usloviya"');
  });
});

describe('renderModerationMail — notices', () => {
  const notice: Partial<ModerationMailData> = {
    kind: 'notice_received',
    facilityName: undefined,
    facilityUrl: undefined,
    reasonLabel: undefined,
    ground: undefined,
    targetUrl: 'https://evil.example/malware',
  };

  it('confirms receipt with the date and what happens next, and no verdict', () => {
    const { subject, text } = mail(notice);
    expect(subject).toBe('We received your notice');
    expect(text).toContain('on 30.09.2026');
    expect(text).toContain('A person will review it and write to you.');
    expect(text).not.toContain('Ground:');
    expect(text).not.toContain('go to court');
  });

  it('echoes the reported URL inert, so a receipt cannot deliver a link', () => {
    const { text, html } = mail(notice);
    expect(text).toContain('https[:]//evil.example/malware');
    expect(html).not.toContain('href="https://evil.example');
  });

  it('reports the outcome and its reason either way', () => {
    const actioned = mail({
      ...notice,
      kind: 'notice_actioned',
      reasonLabel: 'Illegal content',
      ground: 'law',
    });
    expect(actioned.subject).toBe('Decision on your notice');
    expect(actioned.text).toContain('We acted on your notice about');
    expect(actioned.text).toContain('Reason: Illegal content');

    const dismissed = mail({ ...notice, kind: 'notice_dismissed', reasonLabel: 'Not illegal' });
    expect(dismissed.text).toContain('We took no action on your notice about');
    expect(dismissed.text).toContain('Reason: Not illegal');
  });
});
