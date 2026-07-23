**Button** — the primary action control; use for any committed action. Pill-shaped, Manrope 600, sentence-case verb-first labels ("Add a spot" / "Добави място").

```jsx
<Button variant="primary" iconLeft={<MapPin size={20} />}>Добави място</Button>
<Button variant="accent" size="lg">Join the challenge</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost" size="sm">See all</Button>
```

Variants: `primary` (pine, default) · `accent` (clay — max one per view, ideal on photography) · `secondary` (outlined) · `ghost` (text) · `danger`. Sizes `sm|md|lg`. `block` stretches full width. Keyboard focus ring comes from the global `:focus-visible` style.
