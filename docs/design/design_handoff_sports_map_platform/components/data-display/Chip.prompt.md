**Chip** — selectable pill for filters and activity categories. Give it the activity's category color.

```jsx
<Chip color="var(--cat-hike)" icon={<Mountain size={16} />} selected>Hiking</Chip>
<Chip color="var(--cat-bike)" onClick={toggle}>MTB</Chip>
<Chip>Всички</Chip>
```

`selected` fills with a tint of `color`; unselected shows a color dot (or your `icon`). Use in filter rows and the add-a-spot category picker. Static labels → Badge.
