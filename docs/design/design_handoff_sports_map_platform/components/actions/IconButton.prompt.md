**IconButton** — a single-icon button for map controls, toolbars, and compact actions. Always give it an `aria-label`.

```jsx
<IconButton aria-label="Zoom in" variant="floating"><Plus size={20} /></IconButton>
<IconButton aria-label="Filters" variant="surface"><SlidersHorizontal size={20} /></IconButton>
<IconButton aria-label="Like" variant="ghost" round><Heart size={20} /></IconButton>
```

Variants: `surface` (default outlined) · `solid` (pine) · `floating` (white + float shadow, for over-map controls) · `ghost`. `round` for circular. Sizes `sm|md|lg` — keep ≥44px (`md`) for touch.
