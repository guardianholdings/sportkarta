**Switch** — instant on/off toggle (map layers, notifications). Not for form submission choices — use Checkbox there.

```jsx
<Switch label="Покажи само отворени сега" defaultChecked />
<Switch label="Сателитен изглед" checked={sat} onChange={e => setSat(e.target.checked)} />
```

`size` sm|md. Track turns pine when on.
