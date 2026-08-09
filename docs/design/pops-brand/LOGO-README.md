# POPS — знакът „Усмивката“

Логото на **Повече от просто спорт** (pops.bg): две писти на стадион образуват усмивка, две точки са очи. Едно лице, което е и спортно съоръжение отгоре.

## Файлове

- `mark-full.svg` — основен знак, `currentColor` (оцветява се от CSS). Варианти: `-coral`, `-ink`, `-white`.
- `mark-compact.svg` — една писта, **задължителен под 24px** (фавикон, пинове, бродерия).
- `mark-animated.svg` — знакът се изписва (4,4s цикъл, CSS вътре във файла). Работи inline или като `<img>`.
- `pin-free / pin-active / pin-busy` — състояния на картата.
- `icon-app.svg` (1024), `favicon.svg`, `avatar-round.svg`.
- `lockup-horizontal / -stacked / -domain` — изискват шрифт **Unbounded** (Google Fonts). Ако не е наличен, ползвай HTML локъп (по-долу).

## Цветове

| роля                            | hex       |
| ------------------------------- | --------- |
| Корал (знак, акцент)            | `#FF4A2B` |
| Мастило (текст, тъмен фон)      | `#101418` |
| Зелено (карта, свободни обекти) | `#0FA958` |
| Хартия (фон)                    | `#F5F3EE` |
| Сиво (заето / неактивно)        | `#8A9099` |

## Правила

1. Чисто поле около знака = радиусът на едно око (9 единици от viewBox 100).
2. Под 24px винаги `mark-compact`; вътрешната писта се слива.
3. Върху снимка — само бял или мастилен знак, никога корал.
4. Знакът не се върти, не се разтяга, не получава сянка или градиент.
5. Състоянието се носи от устата (усмивка / права линия), цветът само го потвърждава.

## Шрифтове

- Дисплей / логотип: **Unbounded** 700–800
- Текст: **Golos Text** 400–600

```html
<link
  href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;700;800&family=Golos+Text:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

## HTML локъп (препоръчително пред SVG с текст)

```html
<a href="/" style="display:flex;align-items:center;gap:13px;text-decoration:none">
  <img src="/assets/logo/mark-full-coral.svg" width="46" height="46" alt="" />
  <span style="display:flex;flex-direction:column;gap:5px">
    <span
      style="font-family:Unbounded,sans-serif;font-weight:700;font-size:13px;line-height:1.16;
                 text-transform:uppercase;color:#101418"
      >Повече от<br />просто спорт</span
    >
    <span
      style="font-family:'Golos Text',sans-serif;font-weight:600;font-size:10px;
                 letter-spacing:.22em;color:rgba(16,20,24,.45)"
      >POPS.BG</span
    >
  </span>
</a>
```

## Иконки в HTML

```html
<link rel="icon" href="/assets/logo/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/assets/logo/icon-app.png" />
```

Пълната презентация с всички направления и тестове: `Logo Directions.dc.html`.

---

# Отличия (значки)

`assets/logo/badges/` — 14 значки, всяка в два файла: `<slug>.svg` (спечелена) и `<slug>-locked.svg` (заключена, сива).

Всяка значка е монета 200×200: тониран кръг + пунктирана писта по ръба (мотивът от логото) + глиф. Изнасят се като `<img>`, не изискват шрифт.

| файл                  | име               | цел   | семейство             |
| --------------------- | ----------------- | ----- | --------------------- |
| `first-step`          | Първа крачка      | 0/1   | зелено (карта)        |
| `cartographer`        | Картограф         | 0/5   | зелено (карта)        |
| `verifier`            | Проверяващ        | 0/10  | зелено (карта)        |
| `guardian`            | Пазител           | 0/15  | зелено (карта)        |
| `beyond-my-city`      | Отвъд моя град    | 0/3   | зелено (карта)        |
| `allrounder`          | Многоборец        | 0/5   | зелено (карта)        |
| `first-game`          | Първа игра        | 0/1   | корал (игри)          |
| `regular`             | Редовен           | 0/10  | корал (игри)          |
| `persistent`          | Постоянен         | 0/25  | корал (игри)          |
| `half-century`        | Половин стотица   | 0/50  | корал (игри)          |
| `century`             | Стотица           | 0/100 | корал (игри)          |
| `double-half-century` | Двеста и петдесет | 0/250 | корал (игри)          |
| `seven-in-a-row`      | Седем поред       | 0/7   | мастило (постоянство) |
| `month-in-motion`     | Месец в движение  | 0/4   | мастило (постоянство) |

## Прогрес

Пистата по ръба служи и за прогрес бар. За частично изпълнение наслагвай дъга върху заключената значка:

```html
<svg viewBox="0 0 100 100" width="104" height="104">
  <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(16,20,24,.12)" stroke-width="4" />
  <circle
    cx="50"
    cy="50"
    r="45"
    fill="none"
    stroke="#FF4A2B"
    stroke-width="4"
    stroke-linecap="round"
    pathLength="100"
    stroke-dasharray="40 100"
    transform="rotate(-90 50 50)"
  />
</svg>
```

`stroke-dasharray="<процент> 100` = запълнена част.

## Правила

1. Значката никога не се показва в друг цвят освен трите семейства.
2. Заключената е същата форма в сиво — не се замъглява и не се заменя с катинар.
3. Минимален размер 48px; под 64px глифът се ползва без текст отдолу.
