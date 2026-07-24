# Dashboard Chip Primitives — FilterChip / StatusBadge / ActionChip

Three small React components that give every badge in the Aria Ops Board a
**distinct visual language** so a developer (or Bill) can tell at a glance
whether something is a toggle, a status label, or a button.

| Component     | Visual style        | When to use                                                  |
|---------------|---------------------|--------------------------------------------------------------|
| `FilterChip`  | Outlined pill       | Toggle a view / filter / bucket. Clickable, active state.    |
| `StatusBadge` | Heavy-tinted badge  | Read-only status info. Never clickable.                      |
| `ActionChip`  | Filled button       | Perform an imperative action. Looks like a real button.      |

## Quick examples

```tsx
// Toggle a filter view
<FilterChip label="TODAY" count={3} active={true} onClick={handleToggle} tone="red" />

// Show a read-only status
<StatusBadge label="In Transit" tone="cyan" icon={<Truck size={10} />} />

// Trigger an action
<ActionChip label="Order Now" count={2} onClick={handleOrder} variant="primary" />
```

## Rule of thumb

If clicking it **changes what you see** → `<FilterChip>`.  
If it's **pure information** → `<StatusBadge>`.  
If clicking it **does something** (creates a PO, refreshes data) → `<ActionChip>`.
