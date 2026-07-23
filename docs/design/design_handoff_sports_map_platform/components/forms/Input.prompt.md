**Input** — single-line text field; the base for search too (pass a Search icon as `iconLeft`).

```jsx
<Input placeholder="Търси място или дейност" iconLeft={<Search size={18} />} />
<Input placeholder="Email" size="lg" />
<Input defaultValue="Витоша" invalid iconRight={<X size={18} />} />
```

`size` sm|md|lg. `invalid` for errors. Spreads native input props (`type`, `value`, `onChange`, `placeholder`…). Radius md; focus draws the pine ring.
