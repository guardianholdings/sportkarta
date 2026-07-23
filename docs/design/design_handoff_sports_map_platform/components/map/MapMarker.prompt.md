**MapMarker** — the pin that plots spots on the map. Color by activity category; glyph identifies the sport.

```jsx
<MapMarker color="var(--cat-hike)" icon={<Mountain size={18} />} />
<MapMarker color="var(--cat-swim)" icon={<Waves size={18} />} active />
<MapMarker variant="cluster" color="var(--brand)" count={24} />
<MapMarker variant="dot" color="var(--cat-run)" />
```

Variants: `pin` (default, with icon), `dot` (minor/zoomed-out), `cluster` (shows `count`). `active` scales up the selected spot with the trail overshoot. Built from CSS — no image assets.
