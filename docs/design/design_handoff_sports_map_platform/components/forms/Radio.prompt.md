**Radio** — single-choice control; give every option in a group the same `name`.

```jsx
<Radio name="level" value="easy" label="Лесно" defaultChecked />
<Radio name="level" value="mod" label="Умерено" />
<Radio name="level" value="hard" label="Трудно" />
```

Controlled via `checked`+`onChange` or uncontrolled via `defaultChecked`. The dot pops in with the trail overshoot easing.
