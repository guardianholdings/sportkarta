**Card** — surface container for spots, events, clubs, content. Compose Badge/Chip/Stat/Avatar inside.

```jsx
<Card
  interactive
  media={<img src={photo} alt="" style={{ width: '100%', height: 180, objectFit: 'cover' }} />}
>
  <h3 className="t-h3">Черни връх</h3>
  <p className="t-body-sm">Витоша · 8,2 км</p>
</Card>
```

`media` renders flush at top; `padding` none|sm|md|lg controls the body; `interactive` lifts on hover for whole-card links; `footer` sits below a divider.
