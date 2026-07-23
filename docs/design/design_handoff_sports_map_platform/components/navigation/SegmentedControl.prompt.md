**SegmentedControl** — switch between a few views or options; the primary view switcher on the map screen.

```jsx
const [view, setView] = useState('map');
<SegmentedControl
  value={view}
  onChange={setView}
  items={[
    { value: 'map',  label: 'Карта',   icon: <Map size={18} /> },
    { value: 'list', label: 'Списък',  icon: <List size={18} /> },
    { value: 'feed', label: 'Емисия',  icon: <Rss size={18} /> },
  ]}
/>
```

Controlled via `value`+`onChange`. `fullWidth` stretches segments evenly. Sizes sm|md.
