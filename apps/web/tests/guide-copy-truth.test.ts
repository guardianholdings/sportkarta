import { describe, expect, it } from 'vitest';

import { CONTRIBUTION_RADIUS_M } from '@/lib/contributions/proximity';
import {
  CHECKIN_CLOSES_AFTER_MINUTES,
  CHECKIN_OPENS_BEFORE_MINUTES,
  GEOFENCE_RADIUS_M,
} from '@/lib/sessions/checkin';
import { LEGEND_MIN_DAYS, LEGEND_WINDOW_DAYS } from '@sportkarta/db';
import { STREAK_FREEZE_CAP_PER_YEAR } from '@sportkarta/lib/badges';
import { GRACE_WINDOWS, WINDOW_MS } from '@sportkarta/lib/checkin-token';
import {
  DIVISION_ACTIVE_WEEKS,
  DIVISION_MIN_MEMBERS,
  DIVISION_PROMOTE,
  DIVISION_RELEGATE,
  DIVISION_SIZE,
} from '@sportkarta/lib/divisions';
import { ATTENDANCE_AWARDS_PER_DAY, POINTS_BY_EVENT } from '@sportkarta/lib/points';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The front page's guide explains the rules in numbers — 250 metres, +10
 * points, the top 7 of 30 — and every one of them is a constant somewhere in
 * the code that enforces it. This pins each number in the copy to that
 * constant, so a rule that changes cannot leave the front page explaining the
 * old one.
 */

const g = bg.Home.guide;
const e = en.Home.guide;

describe('the guide quotes the rules the code enforces', () => {
  it('on site means 250 metres, for contributions and check-ins alike', () => {
    expect(CONTRIBUTION_RADIUS_M).toBe(GEOFENCE_RADIUS_M);
    const metres = String(CONTRIBUTION_RADIUS_M);
    for (const text of [
      g.contribute.onsite.body,
      g.contribute.lifecycle.s3.body,
      g.play.proof.place.body,
    ]) {
      expect(text).toContain(`${metres} метра`);
    }
    expect(g.contribute.onsite.radius).toBe(`${metres} м`);
    expect(e.contribute.onsite.radius).toBe(`${metres} m`);
  });

  it('prices each action as the ledger does, and the passport shows their sum', () => {
    const { facility_added, facility_verified, condition_reported, session_attended } =
      POINTS_BY_EVENT;
    expect(g.recordings.add.s5.body).toContain(`${facility_added} точки`);
    expect(g.recordings.verify.s2.title).toBe(`+${facility_verified} точки`);
    expect(g.recordings.verify.s4.title).toBe(`+${condition_reported} точки`);
    expect(g.recordings.play.s7.title).toBe(`+${session_attended} точки`);
    const sum = facility_added + facility_verified + condition_reported + session_attended;
    expect(g.recordings.passport.s1.body).toContain(`${sum} точки`);
    expect(e.recordings.passport.s1.body).toContain(`${sum} points`);
  });

  it('pays attendance up to the daily cap', () => {
    expect(g.passport.ledger.session_attended.rule).toContain(`до ${ATTENDANCE_AWARDS_PER_DAY}`);
    expect(g.play.proof.without).toContain(`до ${ATTENDANCE_AWARDS_PER_DAY}`);
  });

  it('opens check-in when the code does, and the code turns over every minute', () => {
    expect(g.play.proof.time.body).toContain(`${CHECKIN_OPENS_BEFORE_MINUTES} минути`);
    expect(g.play.proof.time.body).toContain(`${CHECKIN_CLOSES_AFTER_MINUTES / 60} часа`);
    expect(WINDOW_MS).toBe(60_000);
    expect(g.play.proof.rotate.title).toContain('минута');
    // A code is honoured for its own window plus the grace windows: «до две
    // минути», not «before it reaches a friend».
    expect(((1 + GRACE_WINDOWS) * WINDOW_MS) / 60_000).toBe(2);
    expect(g.play.proof.rotate.body).toContain('до две минути');
  });

  it('forgives as many missed weeks a year as the streak engine does', () => {
    expect(g.passport.streaks.freeze.body).toContain(`${STREAK_FREEZE_CAP_PER_YEAR} пъти`);
  });

  it('describes the divisions with their real sizes', () => {
    const d = g.ranking.divisions;
    expect(d.up).toContain(`${DIVISION_PROMOTE}`);
    expect(d.down).toContain(`${DIVISION_RELEGATE}`);
    expect(d.lead).toContain(`${DIVISION_SIZE}`);
    expect(d.start).toContain(`${DIVISION_MIN_MEMBERS} участници`);
    expect(d.start).toContain(`${DIVISION_ACTIVE_WEEKS} седмици`);
    expect(d.groupLabel).toContain(`${DIVISION_SIZE - DIVISION_PROMOTE - DIVISION_RELEGATE}`);
  });

  it('counts the boards /klasirane actually has, and what each one reads', () => {
    expect(g.ranking.boards.title.split(' ')[0]).toBe(bg.Leaderboard.intro.split(' ')[0]);
    expect(Object.keys(g.ranking.boards)).not.toContain('national');
    // The points board sums the whole ledger (db/src/leaderboard.ts) —
    // attendance included; the participation board reads the training log.
    expect(g.ranking.boards.contributions.body).toContain('присъствия');
    expect(g.ranking.boards.participation.body).toContain('дневника');
    expect(g.ranking.boards.participation.title).toBe(bg.Participation.sectionTitle);
    expect(g.ranking.boards.contributions.title).toBe(bg.Leaderboard.contributionsSectionTitle);
  });

  it('says a campaign MAY cap its points, because perDayCap is optional', () => {
    expect(g.ranking.campaigns.body).toContain('може да има таван');
    expect(e.ranking.campaigns.body).toContain('can cap');
  });

  it('tells who sees a sign-up: the organiser, as the welcome step says', () => {
    expect(bg.Welcome.intro).toContain('организаторите');
    expect(g.faq.who.a).toMatch(/^Организаторът/);
    expect(e.faq.who.a).toMatch(/organiser/);
  });

  it('promises the municipality its figures to embed, not a map', () => {
    expect(g.more.municipality.body).not.toContain('карта');
    expect(e.more.municipality.body).not.toContain('map');
  });

  it('crowns the master of the court as facility legend counts it', () => {
    expect(g.ranking.legend.body).toContain(`${LEGEND_WINDOW_DAYS} дни`);
    expect(g.ranking.legend.body).toContain(`поне ${LEGEND_MIN_DAYS}`);
  });

  it('names the badges by their own names', () => {
    expect(g.passport.streaks.days.body).toContain(bg.Badge.streak_days_7.name);
    expect(g.passport.streaks.weeks.body).toContain(bg.Badge.streak_weeks_4.name);
    expect(g.recordings.play.s7.body).toContain(bg.Badge.first_game.name);
    expect(e.passport.streaks.weeks.body).toContain(en.Badge.streak_weeks_4.name);
    expect(e.recordings.play.s7.body).toContain(en.Badge.first_game.name);
  });
});
