# Component Documentation Template

Use this template for every reusable component added to `packages/web/src/web/components/`.
Delete sections that genuinely do not apply (e.g. a purely structural wrapper with no props),
but do not omit sections just because they are inconvenient to write.

---

## [ComponentName]

**File:** `packages/web/src/web/components/<path>/ComponentName.tsx`
**Introduced:** <!-- date or PR -->
**Status:** `stable` | `experimental` | `deprecated`

### Purpose

<!-- One paragraph. Answer: what problem does this solve, and for whom?
     Mention the design-system category (action, feedback, layout, data-display, etc.).
     Do NOT just restate the component name. -->

---

### Sub-components / Exports

<!-- List every named export from the file.
     For compound components (like Dialog.*) list each sub-component on its own row. -->

| Export | Role |
|--------|------|
| `ComponentName` | Primary entry point |
| `ComponentNameX` | <!-- describe --> |

---

### Props

<!-- One table per exported component that accepts props.
     Include every prop: required ones first, then optional ones alphabetically.
     For props inherited wholesale (e.g. `React.ComponentProps<"button">`) list only
     the overrides/additions — note inheritance at the top of the table. -->

#### `<ComponentName>`

> Inherits all props from `<native element or Radix primitive>` unless noted.

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `propName` | `"value-a" \| "value-b"` | `"value-a"` | No | What it controls and what each value produces. |
| `onAction` | `(payload: PayloadType) => void` | — | Yes | Called when… describe the exact trigger event. |

---

### Usage

#### Minimal

```tsx
import { ComponentName } from "@/components/path/ComponentName";

<ComponentName />
```

#### With all key props

```tsx
<ComponentName
  variant="secondary"
  size="sm"
  onAction={(payload) => console.log(payload)}
>
  Label text
</ComponentName>
```

#### In context (realistic page-level example)

```tsx
// Show how this component fits into a real page/feature.
// Use realistic variable names, not "foo" / "bar".
```

---

### Accessibility

<!-- Be specific — "it's accessible" is not useful here. -->

| Concern | Implementation |
|---------|----------------|
| ARIA role | <!-- e.g. implicit `button`, explicit `role="dialog"` --> |
| Keyboard interaction | <!-- Tab, Enter, Space, Escape, arrow keys — what each does --> |
| Focus management | <!-- where focus lands on open/close, whether focus is trapped --> |
| Screen-reader announcements | <!-- what SR reads out and when (live regions, sr-only spans, aria-label) --> |
| Color contrast | <!-- tokens used, minimum ratio, whether it respects forced-colors --> |
| Reduced motion | <!-- does animation respect prefers-reduced-motion? --> |

---

### Theming & Styling

<!-- Describe the tokens and CVA variants the component exposes.
     List variant names and what they visually produce.
     Note any CSS custom properties or data-attributes callers can target. -->

**CVA variants** (if applicable):

| Variant key | Options | Effect |
|-------------|---------|--------|
| `variant` | `default`, `…` | <!-- describe --> |
| `size` | `sm`, `default`, `lg` | <!-- describe --> |

**Data attributes** emitted (useful for external styling):

| Attribute | Values | When set |
|-----------|--------|----------|
| `data-slot` | `"component-name"` | Always — marks the root element |
| `data-state` | `"open" \| "closed"` | Controlled by Radix when open/closed state applies |

---

### Edge Cases & Known Limitations

<!-- Each bullet is a specific scenario with a specific outcome.
     "May break on mobile" is not useful. "On iOS Safari < 16, focus-visible
     ring does not render on touch — use focus ring CSS workaround X" is useful. -->

- **[Scenario]:** [What happens and what the caller should do about it.]
- **[Scenario]:** …

---

### Do / Don't

<!-- Concrete, opinionated guidance. Use real code snippets, not prose. -->

```tsx
// DO — use variant="destructive" for irreversible actions
<ComponentName variant="destructive">Delete account</ComponentName>

// DON'T — use default variant for destructive actions; the visual weight misleads
<ComponentName>Delete account</ComponentName>
```

---

### Related Components

<!-- Link to docs for components that are commonly used alongside this one,
     or that should be considered as alternatives. -->

- [`RelatedComponent`](./RelatedComponent.md) — used for X
- [`AlternativeComponent`](./AlternativeComponent.md) — prefer when Y

---
---

# Sample Documentation: `Button`

**File:** `packages/web/src/web/components/ui/button.tsx`
**Introduced:** Initial shadcn scaffolding (ADR-030 era)
**Status:** `stable`

### Purpose

The primary interactive control for triggering actions. Handles all action categories — primary
CTA, secondary, destructive, ghost, and inline link — through a single CVA-backed component.
Renders a native `<button>` by default; pass `asChild` to delegate rendering to any child element
(e.g. a router `<Link>`) without losing button styles.

---

### Sub-components / Exports

| Export | Role |
|--------|------|
| `Button` | The button component itself |
| `buttonVariants` | CVA variant factory — use this when you need button styles on a non-`<Button>` element |

---

### Props

#### `<Button>`

> Inherits all native `<button>` props (`onClick`, `type`, `disabled`, `form`, `aria-*`, etc.).

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `variant` | `"default" \| "destructive" \| "outline" \| "secondary" \| "ghost" \| "link"` | `"default"` | No | Visual treatment. `destructive` signals irreversible actions. `link` renders inline with underline on hover. |
| `size` | `"xs" \| "sm" \| "default" \| "lg" \| "icon" \| "icon-xs" \| "icon-sm" \| "icon-lg"` | `"default"` | No | Spatial footprint. `icon*` sizes produce square buttons intended for icon-only content. |
| `asChild` | `boolean` | `false` | No | When `true`, renders the first child element instead of `<button>`, merging button props onto it via Radix `Slot`. Useful for router links styled as buttons. |
| `className` | `string` | — | No | Appended to the computed CVA class string — does not override base styles, only extends them. |

---

### Usage

#### Minimal

```tsx
import { Button } from "@/components/ui/button";

<Button>Save changes</Button>
```

#### Variant showcase

```tsx
<Button variant="default">Confirm</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="destructive">Delete agent</Button>
<Button variant="outline">Export CSV</Button>
<Button variant="ghost">Dismiss</Button>
<Button variant="link">View call transcript</Button>
```

#### Size showcase

```tsx
<Button size="sm">Compact action</Button>
<Button size="lg">Primary CTA</Button>
<Button size="icon" aria-label="Close"><XIcon /></Button>
```

#### As a router link (asChild)

```tsx
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

// Renders a <a> tag with full button styling and router navigation.
<Button asChild variant="outline">
  <Link to="/app/agents">Back to agents</Link>
</Button>
```

#### Disabled with loading state

```tsx
const [saving, setSaving] = useState(false);

<Button disabled={saving} onClick={handleSave}>
  {saving ? "Saving…" : "Save"}
</Button>
```

#### In a form footer (realistic example)

```tsx
<DialogFooter>
  <DialogClose asChild>
    <Button variant="outline">Cancel</Button>
  </DialogClose>
  <Button
    variant="destructive"
    disabled={!confirmed}
    onClick={handleDelete}
  >
    Delete permanently
  </Button>
</DialogFooter>
```

---

### Accessibility

| Concern | Implementation |
|---------|----------------|
| ARIA role | Implicit `role="button"` from the native `<button>` element. When `asChild` renders an `<a>`, the implicit role becomes `link` — add `role="button"` explicitly if the intent is an action, not navigation. |
| Keyboard interaction | `Enter` and `Space` activate the button (native `<button>` behavior). No custom handling needed. |
| Focus management | Focus ring is rendered via `focus-visible:ring-[3px] focus-visible:ring-ring/50` — visible on keyboard focus, suppressed on pointer click. |
| Screen-reader label | Uses button text content as the accessible name. For icon-only buttons (`size="icon"`), you **must** pass `aria-label` — the component does not enforce this automatically. |
| Disabled state | `disabled` prop sets both the HTML `disabled` attribute (removes from tab order, blocks events) and `pointer-events-none opacity-50` styles. Do not use `aria-disabled` as a substitute — it keeps the element tab-focusable but blocks activation, which is a different UX contract. |
| Invalid state | `aria-invalid="true"` triggers `border-destructive` and a destructive-tinted ring via `aria-invalid:border-destructive`. Set this when the button is inside a form field that has failed validation. |
| Color contrast | `default` variant: primary background against primary-foreground text — meets WCAG AA at all theme sizes. `ghost` variant on hover: accent background is light in `.theme-weeber`; ensure text contrast is tested when overriding accent tokens. |
| Reduced motion | No animations on `<Button>` itself. `transition-all` covers only color and opacity changes (< 200ms), which are generally exempt from `prefers-reduced-motion` guidance. |

---

### Theming & Styling

**CVA variants:**

| Variant key | Options | Effect |
|-------------|---------|--------|
| `variant` | `default` | Primary brand fill (`bg-primary`) — use for the single most important action per section |
| | `destructive` | Red fill (`bg-destructive`) — irreversible destructive actions only |
| | `outline` | Transparent with border — secondary actions, cancel buttons |
| | `secondary` | Muted fill (`bg-secondary`) — lower-hierarchy alternatives to `default` |
| | `ghost` | No background until hover — toolbar buttons, icon actions in dense UI |
| | `link` | No background, underline on hover — inline text-level actions |
| `size` | `xs` | 24px height, 12px padding, 12px font — tight spaces, table row actions |
| | `sm` | 32px height — secondary toolbar buttons |
| | `default` | 36px height — standard form buttons |
| | `lg` | 40px height, 24px padding — primary CTAs, landing-page actions |
| | `icon` | 36×36px square — icon-only standard |
| | `icon-xs/sm/lg` | Matching squares for xs/sm/lg icon sizes |

**Data attributes emitted:**

| Attribute | Values | When set |
|-----------|--------|----------|
| `data-slot` | `"button"` | Always |
| `data-variant` | the resolved `variant` string | Always — lets parent components target a specific variant in CSS |
| `data-size` | the resolved `size` string | Always |

**Using `buttonVariants` standalone:**

```tsx
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Apply button styles to a raw element without rendering <Button>
<a href="/app" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
  Go to app
</a>
```

---

### Edge Cases & Known Limitations

- **`asChild` with a fragment or multiple children:** Radix `Slot` expects exactly one child element. Wrapping multiple nodes causes a runtime error. Always pass a single root element when using `asChild`.
- **`asChild` + `<Link>` accessible name:** React Router's `<Link>` renders an `<a>` tag. Screen readers announce it as a link, not a button. If the intent is navigation, this is correct. If the intent is an in-page action (e.g. opening a modal), render a real `<button>` instead.
- **`type` prop default:** Native `<button>` defaults `type` to `"submit"` inside a `<form>`. Always pass `type="button"` for non-submit actions inside forms to prevent accidental form submissions.
- **Long label text:** The `whitespace-nowrap` base class prevents wrapping. A very long label overflows its container rather than wrapping. Either truncate the label or remove `whitespace-nowrap` via `className`.
- **SVG icon sizing:** Icons without an explicit `size-*` class are automatically sized to `16px` via `[&_svg:not([class*='size-'])]:size-4`. If you need a different icon size, add a Tailwind `size-*` class directly on the icon element.

---

### Do / Don't

```tsx
// DO — always label icon-only buttons
<Button size="icon" aria-label="Delete call recording">
  <Trash2Icon />
</Button>

// DON'T — icon-only buttons without aria-label are invisible to screen readers
<Button size="icon">
  <Trash2Icon />
</Button>
```

```tsx
// DO — use type="button" inside forms to avoid accidental submission
<form onSubmit={handleSubmit}>
  <Button type="button" variant="outline" onClick={handleCancel}>Cancel</Button>
  <Button type="submit">Save</Button>
</form>

// DON'T — omitting type inside a form makes every button a submit trigger
<form onSubmit={handleSubmit}>
  <Button variant="outline" onClick={handleCancel}>Cancel</Button>
</form>
```

```tsx
// DO — use asChild for router links that look like buttons
<Button asChild variant="secondary">
  <Link to="/app/calls">View calls</Link>
</Button>

// DON'T — use onClick + navigate() just to style a link as a button
<Button variant="secondary" onClick={() => navigate("/app/calls")}>
  View calls
</Button>
```

---

### Related Components

- [`Dialog` / `DialogFooter`](./dialog.md) — `Button` is the standard action control inside dialog footers
- [`DropdownMenu`](./dropdown-menu.md) — use `DropdownMenuTrigger asChild` with `<Button variant="ghost">` for menu triggers

---
---

# Sample Documentation: `Dialog` (Modal)

**File:** `packages/web/src/web/components/ui/dialog.tsx`
**Introduced:** Initial shadcn scaffolding
**Status:** `stable`

### Purpose

Radix-based modal dialog for confirmations, detail overlays, and multi-step flows that require
focused attention without navigating away. Renders into a portal at the document root, traps focus
while open, and blocks pointer interaction with the page underneath via a backdrop overlay.

---

### Sub-components / Exports

| Export | Role |
|--------|------|
| `Dialog` | Root state container (controlled or uncontrolled) |
| `DialogTrigger` | Wraps the element that opens the dialog |
| `DialogContent` | The visible panel — renders overlay + content into a portal |
| `DialogHeader` | Vertical stack for title + description |
| `DialogTitle` | Accessible dialog title (`aria-labelledby`) |
| `DialogDescription` | Accessible subtitle (`aria-describedby`) |
| `DialogFooter` | Action row — right-aligned on desktop, stacked on mobile |
| `DialogClose` | Wraps any element that should dismiss the dialog |
| `DialogPortal` | Low-level portal wrapper (rarely used directly) |
| `DialogOverlay` | The backdrop scrim (rarely used directly) |

---

### Props

#### `<Dialog>`

> Inherits Radix `Dialog.Root` props.

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `open` | `boolean` | — | No | Controlled open state. Omit for uncontrolled usage. |
| `onOpenChange` | `(open: boolean) => void` | — | No | Called when the open state changes (user dismisses, `Escape` pressed, overlay clicked). Required when `open` is provided. |
| `defaultOpen` | `boolean` | `false` | No | Initial open state for uncontrolled usage. |
| `modal` | `boolean` | `true` | No | When `false`, the dialog does not trap focus or block pointer events — rarely the right choice. |

#### `<DialogContent>`

> Inherits Radix `Dialog.Content` props.

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `showCloseButton` | `boolean` | `true` | No | Renders the `×` icon button in the top-right corner. Set to `false` when the dialog must require an explicit action (e.g. destructive confirmation where accidental dismissal would be confusing). |
| `className` | `string` | — | No | Extends the panel's class list. Use to override `max-w-lg` for wider content. |

#### `<DialogFooter>`

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `showCloseButton` | `boolean` | `false` | No | Appends a `DialogClose`-wrapped `<Button variant="outline">Close</Button>` after any `children`. Convenience shorthand for simple informational dialogs. |
| `className` | `string` | — | No | Extends the footer class list. |

---

### Usage

#### Uncontrolled (trigger inside the composition)

```tsx
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

<Dialog>
  <DialogTrigger asChild>
    <Button variant="outline">View details</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Call summary</DialogTitle>
      <DialogDescription>Review the captured fields from this call.</DialogDescription>
    </DialogHeader>
    {/* content */}
    <DialogFooter showCloseButton />
  </DialogContent>
</Dialog>
```

#### Controlled (open state managed externally)

```tsx
const [open, setOpen] = useState(false);

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Delete agent template</DialogTitle>
      <DialogDescription>
        This action cannot be undone. All orgs using this template will lose their workflow.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="destructive" onClick={handleDelete}>Delete permanently</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

#### Without the close button (forced decision)

```tsx
<DialogContent showCloseButton={false}>
  <DialogHeader>
    <DialogTitle>Confirm phone number</DialogTitle>
    <DialogDescription>
      Enter the code sent to +91 98765 43210 to continue.
    </DialogDescription>
  </DialogHeader>
  <VerificationForm onSuccess={() => setOpen(false)} />
</DialogContent>
```

#### Wider dialog (custom max-width)

```tsx
<DialogContent className="sm:max-w-3xl">
  <WorkflowGraphPreview />
</DialogContent>
```

---

### Accessibility

| Concern | Implementation |
|---------|----------------|
| ARIA role | `role="dialog"` set by Radix on the content panel. `aria-modal="true"` signals to screen readers that background content is inert. |
| Labelling | Radix automatically wires `aria-labelledby` to `<DialogTitle>` and `aria-describedby` to `<DialogDescription>`. Both must be present for a complete accessible name. Omitting `<DialogTitle>` causes an axe violation. |
| Keyboard interaction | `Escape` closes the dialog. `Tab` / `Shift+Tab` cycle through focusable elements inside the panel only (focus trap). Initial focus lands on the first focusable element inside `<DialogContent>`. |
| Focus restoration | On close, Radix returns focus to the element that triggered the dialog open (the `<DialogTrigger>` or the element passed to `onOpenChange`). |
| Overlay interaction | Clicking the overlay calls `onOpenChange(false)` — functionally equivalent to pressing `Escape`. Disable by adding `onPointerDownOutside={(e) => e.preventDefault()}` to `<DialogContent>`. |
| Screen-reader announcements | The dialog title is announced immediately when the panel opens. Radix marks background content with `aria-hidden="true"` so off-panel content is not read. |
| Color contrast | Overlay is `bg-black/50` — sufficient to visually separate content but does not affect the panel's own contrast ratios. Dialog background uses `bg-background` from the active theme. |
| Reduced motion | `animate-in` / `animate-out` classes use CSS animations. Wrap with `@media (prefers-reduced-motion: reduce)` in `globals.css` to disable if needed (not done by default in this codebase). |

---

### Theming & Styling

**Data attributes emitted:**

| Attribute | Element | Values | When set |
|-----------|---------|--------|----------|
| `data-slot` | all sub-components | `"dialog"`, `"dialog-content"`, etc. | Always — identifies each layer for external CSS targeting |
| `data-state` | overlay, content | `"open" \| "closed"` | Driven by Radix — powers the `animate-in`/`animate-out` transitions |

**Overriding panel width:**

The default max-width is `sm:max-w-lg` (512px). Pass `className="sm:max-w-2xl"` (or any breakpoint-prefixed max-width) to `<DialogContent>` to widen it. The panel is always constrained to `max-w-[calc(100%-2rem)]` on viewports narrower than `sm`.

---

### Edge Cases & Known Limitations

- **Nested dialogs:** Radix supports nesting but requires each inner `Dialog` to pass `modal={false}` or the outer dialog will steal the focus trap. Use sparingly — nested modals are almost always a sign the flow needs redesign.
- **Forms inside dialogs:** Controlled `open` state is required when a form submission should close the dialog. With uncontrolled usage there is no programmatic way to close after a successful submit without reaching for a ref.
- **Scroll lock on iOS Safari:** Radix applies `overflow: hidden` to `<body>` when the dialog opens. On iOS 15 and earlier, this can cause a 1px layout shift. This is a known Radix limitation with no clean fix.
- **`onPointerDownOutside` during drag:** If the user starts a drag inside the dialog panel and releases outside, the overlay-click-to-dismiss fires. Prevent with `onPointerDownOutside={(e) => e.preventDefault()}` if the dialog contains draggable content.
- **SSR / hydration:** `DialogPortal` renders into `document.body`, which does not exist during SSR. If rendering server-side, wrap usage in a client-only guard.

---

### Do / Don't

```tsx
// DO — always include DialogTitle even when visually hidden
<DialogContent>
  <DialogHeader>
    <DialogTitle className="sr-only">Confirm deletion</DialogTitle>
  </DialogHeader>
</DialogContent>

// DON'T — omit DialogTitle entirely; this breaks aria-labelledby
<DialogContent>
  <p>Are you sure you want to delete this?</p>
</DialogContent>
```

```tsx
// DO — use controlled state when a form or async action closes the dialog
const [open, setOpen] = useState(false);
<Dialog open={open} onOpenChange={setOpen}>...</Dialog>

// DON'T — rely on uncontrolled state when you need to close after an async call
<Dialog>...</Dialog>
// (no way to call setOpen(false) after API response)
```

```tsx
// DO — pass asChild to DialogTrigger so your existing element is the trigger
<DialogTrigger asChild>
  <Button variant="ghost" size="icon" aria-label="Edit template">
    <PencilIcon />
  </Button>
</DialogTrigger>

// DON'T — wrap your trigger in an extra <button> (double-button, invalid HTML)
<DialogTrigger>
  <Button>Edit template</Button>
</DialogTrigger>
```

---

### Related Components

- [`Sheet`](./sheet.md) — same Radix primitive, slide-in from an edge; prefer for secondary panels and detail drawers
- [`Button`](./button.md) — standard action control used in `DialogFooter`
- [`AlertDialog`](./alert-dialog.md) — use instead of `Dialog` when the only purpose is a destructive confirmation; provides `role="alertdialog"` which announces more urgently to screen readers
