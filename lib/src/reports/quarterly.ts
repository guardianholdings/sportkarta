import type { ReportDefinition } from './schema.js';

/**
 * The national quarterly report (Stage 6.2).
 *
 * PUBLIC, which is what makes it a different document from the grant annex
 * rather than the same one with a wider date range: person-derived figures are
 * k-suppressed here and are not in the annex, because "1 person maintains this
 * municipality's data" next to a municipality name is close enough to a name
 * when anyone can read it, and is ordinary accounting when a named authority
 * reads it under a lawful basis.
 *
 * COVERAGE FIGURES READ THE SAME MATERIALIZED VIEWS AS /statistika. That is the
 * reconciliation standard the roadmap asks for, made structural instead of
 * promised: there is one query behind the public statistics page, the open-data
 * API and this report, so a municipality that checks a quarterly figure against
 * the website cannot find a third number. db/src/reports/reconcile.test.ts
 * asserts it, and stats-reconcile.test.ts already proves the view itself equals
 * a direct query on `facilities`.
 *
 * THE COVERAGE-GAPS TABLE INCLUDES MUNICIPALITIES WITH NO FACILITIES AT ALL,
 * and this is the one thing in the file most likely to be got wrong by a later
 * edit. `mv_municipality_stats` is built with a JOIN onto facilities, so a
 * municipality with zero public facilities is ABSENT from it — and a "coverage
 * gaps" table built from that view would silently omit precisely the worst
 * gaps, while looking complete. The query below starts from `municipalities`
 * and LEFT JOINs the view for that reason.
 *
 * Ranking is only ever among municipalities that HAVE an NSI population figure,
 * matching the accountability pages (Stage 3.4): the rest are reported as
 * unknown and left out of the ordering, never estimated.
 */

export const QUARTERLY_REPORT: ReportDefinition = {
  id: 'quarterly',
  titleBg: 'Национален тримесечен отчет',
  preambleBg:
    'Обобщено състояние на националната мрежа от публични спортни площадки. Числата за обхват идват от същите заявки, които захранват страницата „Статистика“ и отвореното API — така че една и съща величина не може да има две стойности. Всяко число е придружено от заявката, с която е получено (раздел „Методология“). Показателите, изведени от хора, са потиснати при стойност под 5.',
  suppressSmallCounts: true,
  // National only — there is no municipal variant of this document to sum.
  municipalityScoped: false,
  sections: [
    {
      id: 'network',
      titleBg: 'Обхват на мрежата',
      metrics: [
        {
          id: 'facilities_total',
          labelBg: 'Общо публични площадки',
          definitionBg:
            'Всички площадки, видими на публичната карта към момента на изготвяне. Чете се от същия материализиран изглед като страницата „Статистика“.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `SELECT total::int AS value FROM mv_national_stats WHERE id = 1`,
        },
        {
          id: 'facilities_free_pct',
          labelBg: 'Дял със свободен достъп (%)',
          definitionBg:
            'Дял на площадките със свободен публичен достъп от всички публични площадки.',
          unit: 'percent',
          additive: false,
          personDerived: false,
          sql: `
            SELECT round(100.0 * free / nullif(total, 0), 1)::float8 AS value
            FROM mv_national_stats WHERE id = 1
          `,
        },
        {
          id: 'municipalities_covered',
          labelBg: 'Общини с поне една площадка',
          definitionBg: 'Брой общини, в които е картирана поне една публична площадка.',
          unit: 'count',
          additive: false,
          personDerived: false,
          sql: `SELECT municipalities_covered::int AS value FROM mv_national_stats WHERE id = 1`,
        },
        {
          id: 'sports_count',
          labelBg: 'Различни спортове в регистъра',
          definitionBg: 'Брой различни спортове, представени поне веднъж в регистъра.',
          unit: 'count',
          additive: false,
          personDerived: false,
          sql: `SELECT sports_count::int AS value FROM mv_national_stats WHERE id = 1`,
        },
        {
          id: 'facilities_added_quarter',
          labelBg: 'Новодобавени площадки през тримесечието',
          definitionBg: 'Площадки, създадени в системата в рамките на отчетното тримесечие.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value FROM facilities f
            WHERE f.created_at >= :from AND f.created_at < :to AND f.status <> 'gone'
          `,
        },
      ],
    },
    {
      id: 'condition',
      titleBg: 'Състояние на площадките',
      metrics: [
        {
          id: 'condition_reports_quarter',
          labelBg: 'Сигнали за състояние през тримесечието',
          definitionBg: 'Брой сигнали за състоянието на площадка, подадени през тримесечието.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value FROM facility_condition_reports r
            WHERE r.created_at >= :from AND r.created_at < :to
          `,
        },
        {
          id: 'facilities_with_condition',
          labelBg: 'Площадки с известно състояние',
          definitionBg:
            'Публични площадки, за които обществото е съобщило състояние поне веднъж. Останалите са с неизвестно състояние — това е липса на данни, а не добро състояние.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value FROM facilities f
            WHERE f.status <> 'gone' AND f.slug IS NOT NULL AND f.condition IS NOT NULL
          `,
        },
        {
          id: 'facilities_unusable',
          labelBg: 'Площадки, съобщени като неизползваеми',
          definitionBg:
            'Публични площадки, чието последно съобщено състояние е „неизползваемо“. Това е показателят, който изисква действие от стопанина на терена.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value FROM facilities f
            WHERE f.status <> 'gone' AND f.slug IS NOT NULL AND f.condition = 'unusable'
          `,
        },
        {
          id: 'facilities_poor_or_worse_pct',
          labelBg: 'Дял в лошо или неизползваемо състояние (%)',
          definitionBg:
            'Дял на площадките в лошо или неизползваемо състояние от тези с известно състояние. Знаменателят са само площадките с подаден сигнал — изчисляване спрямо всички би представило липсата на данни като добро състояние.',
          unit: 'percent',
          additive: false,
          personDerived: false,
          sql: `
            SELECT round(
              100.0 * count(*) FILTER (WHERE f.condition IN ('poor', 'unusable'))
              / nullif(count(*) FILTER (WHERE f.condition IS NOT NULL), 0), 1)::float8 AS value
            FROM facilities f
            WHERE f.status <> 'gone' AND f.slug IS NOT NULL
          `,
        },
      ],
    },
    {
      id: 'gaps',
      titleBg: 'Празнини в покритието',
      tables: [
        {
          id: 'coverage_gaps',
          titleBg: 'Общини с най-ниско покритие на 10 000 жители',
          definitionBg:
            'Класирането обхваща само общини с официална демографска цифра — останалите не се оценяват и не се подреждат. Общините без нито една картирана площадка СА включени: те са най-голямата празнина и биха отпаднали, ако таблицата се строеше от материализирания изглед, който съдържа само общини с поне една площадка.',
          columnsBg: ['Община', 'Население', 'Площадки', 'На 10 000 жители'],
          columns: ['name_bg', 'population', 'facilities', 'per_10k'],
          personDerived: false,
          sql: `
            SELECT m.name_bg,
                   p.population::int AS population,
                   coalesce(s.total, 0)::int AS facilities,
                   round(coalesce(s.total, 0)::numeric * 10000 / p.population, 2)::float8 AS per_10k
            FROM municipalities m
            JOIN municipality_population p ON p.ekatte_code = m.ekatte_code
            LEFT JOIN mv_municipality_stats s ON s.municipality_id = m.id
            ORDER BY per_10k ASC, m.name_bg
            LIMIT 15
          `,
        },
      ],
    },
    {
      id: 'improving',
      titleBg: 'Най-подобряващи се общини',
      tables: [
        {
          id: 'top_improving',
          titleBg: 'Общини с най-голям принос през тримесечието',
          definitionBg:
            'Подреждане по сбора от новодобавени и проверени на място площадки през тримесечието. Показва къде се е случила работа през периода, а не кой има най-много площадки — голяма община с непроменени данни не се появява тук.',
          columnsBg: ['Община', 'Новодобавени', 'Проверени', 'Общо'],
          columns: ['name_bg', 'added', 'verified', 'total_change'],
          personDerived: false,
          sql: `
            WITH added AS (
              SELECT f.municipality_id, count(*)::int AS n
              FROM facilities f
              WHERE f.created_at >= :from AND f.created_at < :to
                AND f.status <> 'gone' AND f.municipality_id IS NOT NULL
              GROUP BY f.municipality_id
            ), verified AS (
              SELECT f.municipality_id, count(DISTINCT e.facility_id)::int AS n
              FROM facility_edits e
              JOIN facilities f ON f.id = e.facility_id
              WHERE e.created_at >= :from AND e.created_at < :to
                AND e.actor IS NOT NULL AND e.source = 'crowd'
                AND f.municipality_id IS NOT NULL
              GROUP BY f.municipality_id
            )
            SELECT m.name_bg,
                   coalesce(a.n, 0)::int AS added,
                   coalesce(v.n, 0)::int AS verified,
                   (coalesce(a.n, 0) + coalesce(v.n, 0))::int AS total_change
            FROM municipalities m
            LEFT JOIN added a ON a.municipality_id = m.id
            LEFT JOIN verified v ON v.municipality_id = m.id
            WHERE coalesce(a.n, 0) + coalesce(v.n, 0) > 0
            ORDER BY total_change DESC, m.name_bg
            LIMIT 10
          `,
        },
      ],
    },
    {
      id: 'participation',
      titleBg: 'Участие в организирани занимания',
      metrics: [
        {
          id: 'sessions_held_quarter',
          labelBg: 'Проведени занимания',
          definitionBg: 'Занимания с начален час в тримесечието, които не са отменени.',
          unit: 'count',
          additive: true,
          personDerived: false,
          sql: `
            SELECT count(*)::int AS value FROM play_session_occurrences o
            WHERE o.starts_at >= :from AND o.starts_at < :to AND o.status <> 'cancelled'
          `,
        },
        {
          id: 'attendance_qr_quarter',
          labelBg: 'Присъствия, потвърдени с QR проверка',
          definitionBg:
            'Присъствия, потвърдени на място чрез подписан QR код. Самозаявените и отбелязаните от организатор присъствия НЕ са включени тук — само проверените на място се отчитат като потвърдени.',
          unit: 'count',
          additive: true,
          personDerived: true,
          sql: `
            SELECT count(*)::int AS value
            FROM play_session_checkins c
            JOIN play_session_occurrences o ON o.id = c.occurrence_id
            WHERE o.starts_at >= :from AND o.starts_at < :to AND c.method = 'qr'
          `,
        },
        {
          id: 'distinct_attendees_quarter',
          labelBg: 'Различни лица с потвърдено присъствие',
          definitionBg: 'Различни лица с поне едно потвърдено с QR проверка присъствие.',
          unit: 'count',
          additive: false,
          personDerived: true,
          sql: `
            SELECT count(DISTINCT c.user_id)::int AS value
            FROM play_session_checkins c
            JOIN play_session_occurrences o ON o.id = c.occurrence_id
            WHERE o.starts_at >= :from AND o.starts_at < :to AND c.method = 'qr'
          `,
        },
      ],
    },
  ],
};
