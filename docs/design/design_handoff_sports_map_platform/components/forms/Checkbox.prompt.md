**Checkbox** — multi-select control with an accessible hidden input.

```jsx
<Checkbox label="Кучета разрешени" defaultChecked />
<Checkbox label="Достъпно с кола" checked={ok} onChange={e => setOk(e.target.checked)} />
```

Controlled via `checked`+`onChange`, or uncontrolled via `defaultChecked`. Optional `label`.
