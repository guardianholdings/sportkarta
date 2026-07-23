**Avatar** — circular user image with initials fallback.

```jsx
<Avatar name="Ивана Петрова" src={url} size="lg" ring />
<Avatar name="Georgi K" status="online" />
```

`size` xs|sm|md|lg|xl or a px number. `ring` marks the current user; `status` shows a presence dot. Overlap several with negative margin for a member stack.
