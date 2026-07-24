import type { ReportDefinition } from './schema.js';

/**
 * The ММС grant-report annex (Stage 6.2).
 *
 * Scoped by a date range and, optionally, one municipality — the two axes a
 * programme annex is always filed along. Every label is the Bulgarian field
 * name the document format wants; see schema.ts for why those live here rather
 * than in the i18n catalogue.
 *
 * WHAT THIS DOCUMENT DELIBERATELY CANNOT CONTAIN. No names, no per-person rows,
 * no individual attendance dates, no age. It is counts, and the counts are of
 * activity, not of people's characteristics. The operator answered the age
 * question explicitly during Stage 6.2: no under/over-18 split, because the
 * platform derives `is_minor` and discards the date of birth, and a youth
 * figure in an annex invites a follow-up request for the underlying list —
 * which we would have nothing to answer with, and should keep having nothing to
 * answer with. Adding it later is one catalogue entry if ММС ever requires it.
 *
 * THE ATTENDANCE SECTION IS THREE ROWS, NOT ONE, and that is the most
 * audit-relevant decision in this file. Migration 0014 carries a CHECK
 * (`play_session_checkins_only_qr_scores`) encoding that only a QR check-in is
 * evidence: `self` is a button somebody tapped at home and `organizer` is
 * somebody vouching. Summing the three into "посещения" would report to a
 * funder a number our own database refuses to treat as evidence — and it is the
 * number an auditor would ask about first. So the verified figure leads, the
 * other two follow with their own labels, and the methodology says what each
 * one means.
 */

const SCOPE_FACILITY = '(:municipality::int IS NULL OR f.municipality_id = :municipality::int)';

export const GRANT_REPORT: ReportDefinition = {
  id: 'grant',
  titleBg: 'Отчет за програмен период',
  preambleBg:
    'Обобщени показатели за посочения период и обхват. Документът съдържа само броеве — в него няма имена, редове за отделни лица, дати на индивидуално присъствие или възрастови данни. Всяко число е придружено от заявката, с която е получено (раздел „Методология“), така че да може да бъде проверено независимо.',
  // An annex filed with a named authority under a lawful basis must total
  // correctly; withholding a count of 3 would make it unusable for accounting
  // and the ministry would simply ask again. Public reports do suppress.
  suppressSmallCounts: false,
  // Filed per municipality, so the additivity marker earns its place.
  municipalityScoped: true,
  sections: [
    {
      id: 'sessions',
      titleBg: 'Проведени занимания',
      metrics: [
        {
          id: 'sessions_held',
          labelBg: 'Брой проведени занимания',
          definitionBg:
            'Отделни занимания със начален час в периода, които не са отменени. Отменените се изключват — те не са проведени.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_occurrences o
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND o.status <> 'cancelled'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'sessions_cancelled',
          labelBg: 'Брой отменени занимания',
          definitionBg:
            'Занимания с начален час в периода, които са били отменени. Отчитат се отделно, а не се изваждат мълчаливо.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_occurrences o
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND o.status = 'cancelled'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'facilities_used',
          labelBg: 'Брой площадки с проведени занимания',
          definitionBg: 'Различни площадки, на които е проведено поне едно занимание в периода.',
          unit: 'count',
          additive: false,
          personDerived: false,
          sql: `
            SELECT count(DISTINCT f.id)::int AS value
            FROM play_session_occurrences o
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND o.status <> 'cancelled'
              AND ${SCOPE_FACILITY}
          `,
        },
      ],
    },
    {
      id: 'participation',
      titleBg: 'Участие',
      metrics: [
        {
          id: 'signups',
          labelBg: 'Брой записвания за занимания',
          definitionBg:
            'Активни записвания за занимания в периода. Записването е заявено намерение, а не присъствие — присъствието е в следващия раздел.',
          unit: 'count',
          additive: true,
          personDerived: true,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_rsvps r
            JOIN play_session_occurrences o ON o.id = r.occurrence_id
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND o.status <> 'cancelled'
              AND r.state = 'active'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'distinct_participants',
          labelBg: 'Различни участници (записали се)',
          definitionBg:
            'Различни лица с поне едно активно записване в периода. НЕ СЕ СУМИРА между общини: едно лице, участвало в две общини, е един участник на национално ниво и се появява в двата общински отчета.',
          unit: 'count',
          additive: false,
          personDerived: true,
          sql: `
            SELECT count(DISTINCT r.user_id)::int AS value
            FROM play_session_rsvps r
            JOIN play_session_occurrences o ON o.id = r.occurrence_id
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND o.status <> 'cancelled'
              AND r.state = 'active'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'distinct_attendees_verified',
          labelBg: 'Различни лица с потвърдено присъствие',
          definitionBg:
            'Различни лица с поне едно присъствие, потвърдено чрез QR проверка на място. НЕ СЕ СУМИРА между общини.',
          unit: 'count',
          additive: false,
          personDerived: true,
          sql: `
            SELECT count(DISTINCT c.user_id)::int AS value
            FROM play_session_checkins c
            JOIN play_session_occurrences o ON o.id = c.occurrence_id
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND c.method = 'qr'
              AND ${SCOPE_FACILITY}
          `,
        },
      ],
    },
    {
      id: 'attendance',
      titleBg: 'Присъствия по начин на потвърждение',
      metrics: [
        {
          id: 'attendance_qr',
          labelBg: 'Потвърдени с QR проверка на място',
          definitionBg:
            'Присъствия, потвърдени чрез подписан QR код, показан от организатора на място и валиден две минути. Това е единственият вид присъствие, който системата третира като доказано, и единственият, който носи точки.',
          unit: 'count',
          additive: true,
          personDerived: true,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_checkins c
            JOIN play_session_occurrences o ON o.id = c.occurrence_id
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND c.method = 'qr'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'attendance_organizer',
          labelBg: 'Отбелязани от организатор',
          definitionBg:
            'Присъствия, отбелязани от организатора на заниманието. Свидетелство на организатора, не машинна проверка — отчита се отделно и не се сумира с горния ред.',
          unit: 'count',
          additive: true,
          personDerived: true,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_checkins c
            JOIN play_session_occurrences o ON o.id = c.occurrence_id
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND c.method = 'organizer'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'attendance_self',
          labelBg: 'Самозаявени от участника',
          definitionBg:
            'Присъствия, заявени от самия участник без проверка на място. Записват се, защото присъствието е факт, но не представляват доказателство и се отчитат отделно.',
          unit: 'count',
          additive: true,
          personDerived: true,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_checkins c
            JOIN play_session_occurrences o ON o.id = c.occurrence_id
            JOIN play_sessions s ON s.id = o.session_id
            JOIN facilities f ON f.id = s.facility_id
            WHERE o.starts_at >= :from AND o.starts_at < :to
              AND c.method = 'self'
              AND ${SCOPE_FACILITY}
          `,
        },
      ],
    },
    {
      id: 'facilities',
      titleBg: 'Данни за площадките',
      metrics: [
        {
          id: 'facilities_in_scope',
          labelBg: 'Площадки в обхвата (към датата на изготвяне)',
          definitionBg:
            'Публично видими площадки в обхвата към момента на изготвяне на отчета. Това е състояние към днешна дата, а не брой за периода.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value
            FROM facilities f
            WHERE f.status <> 'gone' AND f.slug IS NOT NULL
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'facilities_added',
          labelBg: 'Новодобавени площадки в периода',
          definitionBg: 'Публично видими площадки, създадени в системата в рамките на периода.',
          unit: 'count',
          additive: true,
          personDerived: false,
          // The same public-visibility predicate as the map and mv_national_stats
          // (status <> 'gone' AND slug IS NOT NULL): a report must not count a
          // row the public register does not show.
          sql: `
            SELECT count(*)::int AS value
            FROM facilities f
            WHERE f.created_at >= :from AND f.created_at < :to
              AND f.status <> 'gone' AND f.slug IS NOT NULL
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'facilities_verified',
          labelBg: 'Проверени на място площадки в периода',
          definitionBg:
            'Различни площадки, за които в периода е вписана проверка от регистриран доброволец. Броят е на площадки, не на проверки.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(DISTINCT e.facility_id)::int AS value
            FROM facility_edits e
            JOIN facilities f ON f.id = e.facility_id
            WHERE e.created_at >= :from AND e.created_at < :to
              AND e.actor IS NOT NULL
              AND e.source = 'crowd'
              AND ${SCOPE_FACILITY}
          `,
        },
        {
          id: 'condition_reports',
          labelBg: 'Подадени сигнали за състояние в периода',
          definitionBg:
            'Сигнали за състоянието на площадка, подадени в периода от посетители на сайта.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value
            FROM facility_condition_reports r
            JOIN facilities f ON f.id = r.facility_id
            WHERE r.created_at >= :from AND r.created_at < :to
              AND ${SCOPE_FACILITY}
          `,
        },
      ],
    },
    {
      id: 'volunteers',
      titleBg: 'Доброволци и посланици',
      metrics: [
        {
          id: 'ambassadors_active',
          labelBg: 'Активни посланици в периода',
          definitionBg:
            'Различни посланици, взели поне едно решение по модерация в периода в рамките на обхвата. НЕ СЕ СУМИРА между общини — един посланик може да отговаря за няколко.',
          unit: 'count',
          additive: false,
          personDerived: true,
          sql: `
            SELECT count(DISTINCT d.actor_id)::int AS value
            FROM moderation_decisions d
            WHERE d.decided_at >= :from AND d.decided_at < :to
              AND (:municipality::int IS NULL OR d.municipality_id = :municipality::int)
          `,
        },
        {
          id: 'moderation_decisions',
          labelBg: 'Решения по модерация в периода',
          definitionBg:
            'Брой вписани решения по подадени сигнали, снимки и площадки, чакащи проверка.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value
            FROM moderation_decisions d
            WHERE d.decided_at >= :from AND d.decided_at < :to
              AND (:municipality::int IS NULL OR d.municipality_id = :municipality::int)
          `,
        },
        {
          id: 'contributors_active',
          labelBg: 'Различни доброволци с принос в периода',
          definitionBg:
            'Различни регистрирани лица, вписали поне една промяна по площадка в периода. НЕ СЕ СУМИРА между общини.',
          unit: 'count',
          additive: false,
          personDerived: true,
          sql: `
            SELECT count(DISTINCT e.actor)::int AS value
            FROM facility_edits e
            JOIN facilities f ON f.id = e.facility_id
            WHERE e.created_at >= :from AND e.created_at < :to
              AND e.actor IS NOT NULL
              AND ${SCOPE_FACILITY}
          `,
        },
      ],
    },
  ],
};
